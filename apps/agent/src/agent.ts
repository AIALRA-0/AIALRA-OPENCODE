import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentEnvelopeSchema,
  EncryptedChannelFrameSchema,
  RelayHttpCancelSchema,
  RelayHttpRequestSchema,
  RelayPayloadSchema,
  RelaySocketCloseSchema,
  RelaySocketDataSchema,
  RelaySocketOpenSchema,
  RouteCapabilityManifestSchema,
  type AgentEnvelope,
  type RelayHttpRequest,
  type RelayPayload,
} from "@aialra-opencode/protocol";
import WebSocket, { type RawData } from "ws";
import { HeartbeatWatchdog } from "./heartbeat.js";
import {
  stalePtyIdFromResource,
  stalePtyIdFromSocket,
} from "./pty-recovery.js";
import { ptyUpstreamClose } from "./pty-upstream-error.js";
import type { AgentConfig } from "./config.js";
import { OpenCodeServer, type OpenCodeProbe } from "./opencode-server.js";
import {
  requestContainsSecretConfiguration,
  sanitizedConfigurationResponse,
} from "./response-policy.js";
import { RoutePolicy } from "./route-policy.js";
import { grantPublicKey, SecureChannel } from "./secure-channel.js";

const AGENT_VERSION = "0.1.0";
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
const MAX_RELAY_CHUNK_BYTES = 512 * 1024;
const MAX_STALE_PTY_IDS = 256;
const CAPABILITIES = ["http", "manual-permissions", "pty", "sse"];

interface ChannelRuntime {
  secure: SecureChannel;
  requests: Map<string, AbortController>;
  sockets: Map<
    string,
    { socket: WebSocket; nextInboundSequence: number; inputObserved: boolean }
  >;
}

function websocketUrl(server: string): string {
  const url = new URL(server);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("control-plane URL must use HTTP or HTTPS");
  url.pathname = "/ws/v1/agent";
  url.search = "";
  url.hash = "";
  return url.href;
}

function json(socket: WebSocket, payload: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function rawBytes(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, item) => total + item.byteLength, 0)
    : data.byteLength;
}

function rawBuffer(data: RawData): Buffer {
  if (Array.isArray(data))
    return Buffer.concat(data.map((item) => Buffer.from(item)));
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function relayErrorCode(error: unknown, aborted: boolean): string {
  if (aborted) return "cancelled";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("not present in the pinned capability manifest"))
    return "route_not_allowed";
  if (message.includes("body exceeds")) return "body_limit_exceeded";
  if (message.includes("capability grant")) return "capability_denied";
  if (message.includes("secret-bearing configuration"))
    return "configuration_secret_rejected";
  if (message.includes("escaped the loopback"))
    return "loopback_escape_rejected";
  return "upstream_request_failed";
}

export function relayRouteFingerprint(method: string, path: string): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}`)
    .digest("hex")
    .slice(0, 16);
}

const ROUTE_NAMESPACES = new Set([
  "agent",
  "api",
  "command",
  "config",
  "event",
  "experimental",
  "file",
  "find",
  "formatter",
  "global",
  "lsp",
  "mcp",
  "path",
  "permission",
  "project",
  "provider",
  "pty",
  "question",
  "session",
  "skill",
  "tui",
  "vcs",
]);

const API_ROUTE_NAMESPACES = new Set([
  "agent",
  "command",
  "config",
  "credential",
  "event",
  "fs",
  "health",
  "integration",
  "location",
  "mcp",
  "model",
  "path",
  "permission",
  "provider",
  "project",
  "pty",
  "question",
  "reference",
  "session",
  "skill",
  "vcs",
]);

export function relayRouteShape(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const root = segments[0] ?? "root";
  const base = ROUTE_NAMESPACES.has(root) ? root : "unknown";
  const child = segments[1] ?? "root";
  const namespace =
    base === "api"
      ? `api/${API_ROUTE_NAMESPACES.has(child) ? child : "unknown"}`
      : base;
  return `${namespace}:${segments.length}:${path.endsWith("/") ? "slash" : "plain"}`;
}

export class AgentRuntime {
  private readonly identityPrivateKey;
  private readonly grantVerificationKey;
  private readonly policy: RoutePolicy;
  private readonly server: OpenCodeServer;
  private readonly channels = new Map<string, ChannelRuntime>();
  private readonly stalePtys = new Set<string>();
  private probe: OpenCodeProbe | null = null;
  private control: WebSocket | null = null;
  private stopping = false;

  private constructor(
    private readonly config: AgentConfig,
    policy: RoutePolicy,
  ) {
    this.policy = policy;
    this.identityPrivateKey = createPrivateKey(config.identityPrivateKeyPem);
    this.grantVerificationKey = grantPublicKey(config.grantVerificationKeyPem);
    this.server = new OpenCodeServer(
      config.opencodePath,
      config.expectedVersion,
      config.expectedOpenapiSha256,
    );
  }

  static async create(config: AgentConfig): Promise<AgentRuntime> {
    const manifestRaw = await readFile(config.manifestPath, "utf8");
    const policy = new RoutePolicy(
      RouteCapabilityManifestSchema.parse(JSON.parse(manifestRaw)),
    );
    if (
      policy.manifest.upstreamCommit !== config.upstreamCommit ||
      policy.manifest.openapiSha256 !== config.expectedOpenapiSha256
    ) {
      throw new Error(
        "agent configuration and route manifest do not describe the same release",
      );
    }
    return new AgentRuntime(config, policy);
  }

  async run(): Promise<void> {
    this.probe = await this.server.start();
    let backoff = 500;
    while (!this.stopping) {
      try {
        await this.connectOnce();
        backoff = 500;
      } catch (error) {
        if (this.stopping) break;
        process.stderr.write(
          `[agent] relay disconnected: ${error instanceof Error ? error.name : "unknown"}\n`,
        );
        await delay(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.control?.close(1000, "agent stopping");
    this.closeChannels();
    await this.server.stop();
  }

  private async connectOnce(): Promise<void> {
    const probe = await this.server.start();
    const socket = new WebSocket(websocketUrl(this.config.server), {
      maxPayload: MAX_CONTROL_FRAME_BYTES,
    });
    this.control = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("control-plane connection timed out")),
        10_000,
      );
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", reject);
    });
    json(socket, this.hello(probe));
    const watchdog = new HeartbeatWatchdog(25_000);
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (watchdog.expired()) {
        socket.terminate();
        return;
      }
      json(socket, {
        type: "agent.heartbeat",
        hostId: this.config.hostId,
        sequence: Date.now(),
        state: "online",
        opencodeVersion: probe.version,
        openapiSha256: probe.openapiSha256,
      });
    }, 10_000);
    await new Promise<void>((resolve, reject) => {
      socket.on("message", (data, binary) => {
        if (binary || rawBytes(data) > MAX_CONTROL_FRAME_BYTES)
          return socket.close(1009, "invalid relay frame");
        void this.onControlMessage(socket, data.toString(), () =>
          watchdog.acknowledge(),
        ).catch((error) => {
          process.stderr.write(
            `[agent] control message rejected: ${error instanceof Error ? error.message : "unknown"}\n`,
          );
          socket.close(1008, "relay message rejected");
        });
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    }).finally(() => {
      clearInterval(heartbeat);
      if (this.control === socket) this.control = null;
      this.closeChannels();
    });
  }

  private hello(probe: OpenCodeProbe): AgentEnvelope {
    const timestamp = Date.now();
    const nonce = randomBytes(24).toString("base64url");
    const canonical = [
      this.config.hostId,
      String(timestamp),
      nonce,
      AGENT_VERSION,
      probe.version,
      probe.openapiSha256,
      this.config.upstreamCommit,
      CAPABILITIES.join(","),
    ].join("\n");
    return AgentEnvelopeSchema.parse({
      type: "agent.hello",
      requestId: crypto.randomUUID(),
      hostId: this.config.hostId,
      timestamp,
      nonce,
      signature: sign(
        null,
        Buffer.from(canonical),
        this.identityPrivateKey,
      ).toString("base64url"),
      agentVersion: AGENT_VERSION,
      opencodeVersion: probe.version,
      openapiSha256: probe.openapiSha256,
      upstreamCommit: this.config.upstreamCommit,
      capabilities: CAPABILITIES,
    });
  }

  private async onControlMessage(
    socket: WebSocket,
    raw: string,
    acknowledgeHeartbeat: () => void,
  ): Promise<void> {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type === "server.heartbeat") {
      if (!Number.isSafeInteger(value.sequence))
        throw new Error("invalid server heartbeat");
      acknowledgeHeartbeat();
      return;
    }
    if (value.type === "server.hello") {
      if (value.compatible !== true)
        throw new Error("control plane rejected the pinned OpenCode contract");
      return;
    }
    if (value.type === "browser.channel.open") {
      const input = value as Record<string, unknown>;
      const accepted = SecureChannel.accept({
        channelId: String(input.channelId),
        kind: input.channel as
          | "opencode-http"
          | "opencode-event"
          | "opencode-pty",
        hostId: this.config.hostId,
        subject: String(input.subject),
        browserKey: String(input.browserEphemeralKey),
        grantToken: String(input.grant),
        grantVerificationKey: this.grantVerificationKey,
        identityPrivateKey: this.identityPrivateKey,
      });
      this.channels.set(accepted.channel.id, {
        secure: accepted.channel,
        requests: new Map(),
        sockets: new Map(),
      });
      json(socket, {
        type: "agent.channel.accept",
        requestId: input.requestId,
        hostId: this.config.hostId,
        channelId: accepted.channel.id,
        agentEphemeralKey: accepted.agentEphemeralKey,
        signature: accepted.signature,
      });
      return;
    }
    if (value.type === "browser.channel.close") {
      this.closeChannel(String(value.channelId));
      return;
    }
    if (value.type !== "browser.frame") return;
    const frame = EncryptedChannelFrameSchema.parse(value.frame);
    const runtime = this.channels.get(
      String((value.frame as Record<string, unknown>)?.channelId),
    );
    if (!runtime) {
      json(socket, {
        type: "agent.error",
        requestId: null,
        hostId: this.config.hostId,
        code: "unknown_channel",
        message: "Encrypted channel is no longer available",
      });
      return;
    }
    const payload = RelayPayloadSchema.parse(runtime.secure.decrypt(frame));
    await this.dispatch(socket, runtime, payload);
  }

  private async dispatch(
    socket: WebSocket,
    runtime: ChannelRuntime,
    payload: RelayPayload,
  ): Promise<void> {
    if (payload.type === "relay.http.request") {
      const request = RelayHttpRequestSchema.parse(payload);
      void this.handleHttp(socket, runtime, request);
      return;
    }
    if (payload.type === "relay.http.cancel") {
      const cancel = RelayHttpCancelSchema.parse(payload);
      runtime.requests.get(cancel.requestId)?.abort();
      return;
    }
    if (payload.type === "relay.socket.open") {
      await this.openSocket(
        socket,
        runtime,
        RelaySocketOpenSchema.parse(payload),
      );
      return;
    }
    if (payload.type === "relay.socket.data") {
      const data = RelaySocketDataSchema.parse(payload);
      const target = runtime.sockets.get(data.socketId);
      if (!target || data.sequence !== target.nextInboundSequence)
        throw new Error("socket sequence mismatch");
      target.nextInboundSequence += 1;
      if (!target.inputObserved) {
        target.inputObserved = true;
        process.stderr.write("[agent] PTY input relay active\n");
      }
      target.socket.send(Buffer.from(data.dataBase64, "base64url"), {
        binary: data.binary,
      });
      return;
    }
    if (payload.type === "relay.socket.close") {
      const close = RelaySocketCloseSchema.parse(payload);
      runtime.sockets
        .get(close.socketId)
        ?.socket.close(close.code, close.reason);
    }
  }

  private async handleHttp(
    socket: WebSocket,
    runtime: ChannelRuntime,
    request: RelayHttpRequest,
  ): Promise<void> {
    const controller = new AbortController();
    runtime.requests.set(request.requestId, controller);
    try {
      const route = this.policy.authorizeHttp(request);
      const scope =
        route.category === "event"
          ? "event.stream"
          : route.category === "read"
            ? "http.read"
            : "http.write";
      const expectedChannel =
        route.category === "event" ? "opencode-event" : "opencode-http";
      if (
        !runtime.secure.allows(scope) ||
        runtime.secure.kind !== expectedChannel
      )
        throw new Error("capability grant does not authorize this route");
      const stalePtyId = stalePtyIdFromResource(request.path);
      if (
        request.method === "GET" &&
        stalePtyId &&
        this.stalePtys.has(stalePtyId)
      ) {
        this.sendEncrypted(socket, runtime, {
          type: "relay.http.response.start",
          requestId: request.requestId,
          status: 404,
          headers: {},
        });
        this.sendEncrypted(socket, runtime, {
          type: "relay.http.end",
          requestId: request.requestId,
          errorCode: null,
        });
        return;
      }
      const probe = await this.server.start();
      const url = new URL(request.path, probe.baseUrl);
      url.search = request.query;
      if (url.origin !== probe.baseUrl.origin)
        throw new Error("request escaped the loopback OpenCode origin");
      const headers = this.policy.requestHeaders(request.headers);
      headers.set("authorization", probe.authorization);
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: controller.signal,
      };
      const requestBody = request.bodyBase64
        ? Buffer.from(request.bodyBase64, "base64url")
        : null;
      if (requestContainsSecretConfiguration(request.path, requestBody))
        throw new Error("secret-bearing configuration write rejected");
      if (requestBody) init.body = requestBody;
      const response = await fetch(url, init);
      const sanitized = await sanitizedConfigurationResponse(
        request.path,
        response,
      );
      const responseHeaders = new Headers(response.headers);
      if (sanitized) responseHeaders.delete("content-length");
      this.sendEncrypted(socket, runtime, {
        type: "relay.http.response.start",
        requestId: request.requestId,
        status: response.status,
        headers: this.policy.responseHeaders(responseHeaders),
      });
      let sequence = 0;
      if (sanitized) {
        for (
          let offset = 0;
          offset < sanitized.byteLength;
          offset += MAX_RELAY_CHUNK_BYTES
        ) {
          const chunk = sanitized.subarray(
            offset,
            Math.min(offset + MAX_RELAY_CHUNK_BYTES, sanitized.byteLength),
          );
          this.sendEncrypted(socket, runtime, {
            type: "relay.http.chunk",
            requestId: request.requestId,
            sequence: sequence++,
            bodyBase64: Buffer.from(chunk).toString("base64url"),
          });
        }
      } else if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (
            let offset = 0;
            offset < value.byteLength;
            offset += MAX_RELAY_CHUNK_BYTES
          ) {
            const chunk = value.subarray(
              offset,
              Math.min(offset + MAX_RELAY_CHUNK_BYTES, value.byteLength),
            );
            this.sendEncrypted(socket, runtime, {
              type: "relay.http.chunk",
              requestId: request.requestId,
              sequence: sequence++,
              bodyBase64: Buffer.from(chunk).toString("base64url"),
            });
          }
        }
      }
      this.sendEncrypted(socket, runtime, {
        type: "relay.http.end",
        requestId: request.requestId,
        errorCode: null,
      });
    } catch (error) {
      const errorCode = relayErrorCode(error, controller.signal.aborted);
      if (errorCode !== "cancelled") {
        const route = relayRouteFingerprint(request.method, request.path);
        process.stderr.write(
          `[agent] HTTP relay failed: ${errorCode} method=${request.method} route=${route} shape=${relayRouteShape(request.path)}\n`,
        );
      }
      this.sendEncrypted(socket, runtime, {
        type: "relay.http.end",
        requestId: request.requestId,
        errorCode,
      });
    } finally {
      runtime.requests.delete(request.requestId);
    }
  }

  private async openSocket(
    socket: WebSocket,
    runtime: ChannelRuntime,
    input: ReturnType<typeof RelaySocketOpenSchema.parse>,
  ): Promise<void> {
    this.policy.authorizeSocket(input.path);
    if (
      runtime.secure.kind !== "opencode-pty" ||
      !runtime.secure.allows("pty.connect")
    )
      throw new Error("capability grant does not authorize PTY");
    const probe = await this.server.start();
    const url = new URL(input.path, probe.baseUrl);
    url.search = input.query;
    url.protocol = "ws:";
    if (
      url.hostname !== "127.0.0.1" ||
      Number(url.port) !== Number(probe.baseUrl.port)
    )
      throw new Error("PTY request escaped the loopback OpenCode origin");
    const target = new WebSocket(url, input.protocols, {
      headers: { authorization: probe.authorization },
      handshakeTimeout: 10_000,
      maxPayload: MAX_CONTROL_FRAME_BYTES,
    });
    runtime.sockets.set(input.socketId, {
      socket: target,
      nextInboundSequence: 0,
      inputObserved: false,
    });
    let sequence = 0;
    let finished = false;
    let upstreamFailed = false;
    const finish = (code: number, reason: string) => {
      if (finished) return;
      finished = true;
      runtime.sockets.delete(input.socketId);
      this.sendEncrypted(socket, runtime, {
        type: "relay.socket.close",
        socketId: input.socketId,
        code: code >= 1000 && code <= 4999 ? code : 1006,
        reason: reason.slice(0, 123),
      });
    };
    target.once("open", () => {
      process.stderr.write("[agent] PTY upstream connected\n");
      this.sendEncrypted(socket, runtime, { ...input });
    });
    target.on("message", (data, binary) =>
      this.sendEncrypted(socket, runtime, {
        type: "relay.socket.data",
        socketId: input.socketId,
        sequence: sequence++,
        binary,
        dataBase64: rawBuffer(data).toString("base64url"),
      }),
    );
    target.once("error", (error) => {
      upstreamFailed = true;
      process.stderr.write("[agent] PTY upstream connection failed\n");
      const close = ptyUpstreamClose(error);
      if (close.code === 4404 || close.code === 4410) {
        const stalePtyId = stalePtyIdFromSocket(input.path);
        if (stalePtyId) {
          this.stalePtys.add(stalePtyId);
          while (this.stalePtys.size > MAX_STALE_PTY_IDS) {
            const oldest = this.stalePtys.values().next().value;
            if (typeof oldest !== "string") break;
            this.stalePtys.delete(oldest);
          }
        }
      }
      finish(close.code, close.reason);
    });
    target.once("close", (code, reason) => {
      if (upstreamFailed) return;
      finish(code, reason.toString("utf8"));
    });
  }

  private sendEncrypted(
    socket: WebSocket,
    runtime: ChannelRuntime,
    payload: RelayPayload,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    json(socket, {
      type: "agent.frame",
      hostId: this.config.hostId,
      frame: runtime.secure.encrypt(payload),
    });
  }

  private closeChannel(channelId: string): void {
    const runtime = this.channels.get(channelId);
    if (!runtime) return;
    for (const controller of runtime.requests.values()) controller.abort();
    for (const target of runtime.sockets.values())
      target.socket.close(1001, "relay channel closed");
    this.channels.delete(channelId);
  }

  private closeChannels(): void {
    for (const channelId of [...this.channels.keys()])
      this.closeChannel(channelId);
  }
}

export async function enroll(input: {
  server: string;
  code: string;
  displayName: string;
  mode: "vps" | "remote";
}): Promise<
  Pick<
    AgentConfig,
    | "hostId"
    | "identityPrivateKeyPem"
    | "identityPublicKeyPem"
    | "grantVerificationKeyPem"
  >
> {
  const { generateKeyPairSync } = await import("node:crypto");
  const keys = generateKeyPairSync("ed25519");
  const identityPrivateKeyPem = keys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const identityPublicKeyPem = createPublicKey(keys.privateKey)
    .export({ format: "pem", type: "spki" })
    .toString();
  const socket = new WebSocket(websocketUrl(input.server), {
    maxPayload: MAX_CONTROL_FRAME_BYTES,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const response = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("agent enrollment timed out")),
        15_000,
      );
      socket.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(
          new Error(
            `control plane closed enrollment (${code} ${reason.toString("utf8").slice(0, 80)})`,
          ),
        );
      });
      json(socket, {
        type: "agent.enroll",
        requestId: crypto.randomUUID(),
        code: input.code,
        publicKey: identityPublicKeyPem,
        displayName: input.displayName,
        mode: input.mode,
        platform: process.platform === "win32" ? "windows" : "linux",
        agentVersion: AGENT_VERSION,
      });
    },
  );
  socket.close();
  if (response.type !== "server.enrolled")
    throw new Error("control plane rejected agent enrollment");
  return {
    hostId: String(response.hostId),
    identityPrivateKeyPem,
    identityPublicKeyPem,
    grantVerificationKeyPem: String(response.grantVerificationKey),
  };
}

export function sha256FileContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
