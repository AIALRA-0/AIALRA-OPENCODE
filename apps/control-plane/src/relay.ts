import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  AgentEnvelopeSchema,
  BrowserEnvelopeSchema,
  type AgentEnvelope,
  type HostState,
} from "@aialra-opencode/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService, Principal } from "./auth.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { GrantSigner } from "./crypto.js";
import type { ControlPlaneDatabase } from "./database.js";

interface AgentConnection {
  socket: WebSocket;
  hostId: string;
  authenticated: boolean;
}

interface BrowserConnection {
  socket: WebSocket;
  principal: Principal;
  channels: Map<
    string,
    {
      hostId: string;
      grant: string;
      grantId: string;
      channel: string;
      lastSequence: number;
    }
  >;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_AGENT_CONNECTIONS = 128;
const MAX_BROWSER_CONNECTIONS = 16;
const MAX_CHANNELS_PER_BROWSER = 8;
const MAX_HANDSHAKES_PER_MINUTE = 600;
const MAX_AGENT_MESSAGES_PER_TEN_SECONDS = 3_000;
const MAX_BROWSER_MESSAGES_PER_TEN_SECONDS = 600;
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_MISSED_HEARTBEATS = 2;

export function classifyRelayClose(code: number): string {
  if (code === 1000) return "normal";
  if (code === 1001) return "shutdown";
  if (code === 1008) return "policy_violation";
  if (code === 1009) return "frame_too_large";
  if (code === 1013) return "transient_failure";
  if (code === 4001) return "connection_replaced";
  if (code === 4003) return "identity_revoked";
  if (code === 4008) return "heartbeat_timeout";
  return "protocol_failure";
}

function installHeartbeat(socket: WebSocket): () => void {
  let alive = true;
  let missed = 0;
  let stopped = false;
  const onPong = () => {
    alive = true;
  };
  socket.on("pong", onPong);
  const timer = setInterval(() => {
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      missed += 1;
      if (missed >= MAX_MISSED_HEARTBEATS) {
        socket.close(4008, "relay heartbeat timeout");
        return;
      }
    } else {
      missed = 0;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off("pong", onPong);
  };
}

function logRelayClose(
  role: "agent" | "browser",
  code: number,
  connectedAt: number,
  channelCount: number,
): void {
  console.info(
    `[relay] role=${role} close_category=${classifyRelayClose(code)} code=${code} duration_ms=${Math.max(0, Date.now() - connectedAt)} channels=${channelCount}`,
  );
}

export interface RateWindow {
  startedAt: number;
  count: number;
}

export function consumeRate(
  window: RateWindow,
  maximum: number,
  durationMs: number,
  now = Date.now(),
): boolean {
  if (now - window.startedAt >= durationMs) {
    window.startedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= maximum;
}

export function parseCookies(
  value: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      result[part.slice(0, index).trim()] = decodeURIComponent(
        part.slice(index + 1).trim(),
      );
    } catch {
      // Ignore a malformed cookie rather than letting an upgrade request terminate the process.
    }
  }
  return result;
}

interface RelaySocket {
  readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}

interface OutboundQueue {
  items: Array<{ data: string; bytes: number }>;
  bytes: number;
  sending: boolean;
}

const outboundQueues = new WeakMap<RelaySocket, OutboundQueue>();

function flush(socket: RelaySocket, queue: OutboundQueue): void {
  if (queue.sending || socket.readyState !== WebSocket.OPEN) return;
  const item = queue.items.shift();
  if (!item) return;
  queue.bytes -= item.bytes;
  queue.sending = true;
  try {
    socket.send(item.data, (error) => {
      queue.sending = false;
      if (error) {
        queue.items.length = 0;
        queue.bytes = 0;
        socket.close(1013, "relay send failed");
        return;
      }
      flush(socket, queue);
    });
  } catch {
    queue.sending = false;
    queue.items.length = 0;
    queue.bytes = 0;
    socket.close(1013, "relay send failed");
  }
}

export function sendRelayMessage(socket: RelaySocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(payload);
  const bytes = Buffer.byteLength(data);
  let queue = outboundQueues.get(socket);
  if (!queue) {
    queue = { items: [], bytes: 0, sending: false };
    outboundQueues.set(socket, queue);
  }
  if (queue.bytes + bytes > MAX_QUEUED_BYTES) {
    queue.items.length = 0;
    queue.bytes = 0;
    socket.close(1013, "relay backpressure");
    return;
  }
  queue.items.push({ data, bytes });
  queue.bytes += bytes;
  flush(socket, queue);
}

export function sendRelayMessageAndClose(
  socket: RelaySocket,
  payload: unknown,
  code: number,
  reason: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload), (error) => {
      socket.close(error ? 1013 : code, error ? "relay send failed" : reason);
    });
  } catch {
    socket.close(1013, "relay send failed");
  }
}

const send = sendRelayMessage;

function rawDataBytes(data: import("ws").RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, item) => total + item.byteLength, 0)
    : data.byteLength;
}

export class RelayService {
  private readonly agentServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly browserServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  private readonly agents = new Map<string, AgentConnection>();
  private readonly browsers = new Set<BrowserConnection>();
  private readonly expectedVersion: string;
  private readonly expectedOpenApi: string;
  private readonly expectedCommit: string;
  private readonly agentHandshakeRate: RateWindow = {
    startedAt: Date.now(),
    count: 0,
  };
  private readonly browserHandshakeRate: RateWindow = {
    startedAt: Date.now(),
    count: 0,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly db: ControlPlaneDatabase,
    private readonly auth: AuthService,
    private readonly signer: GrantSigner,
    upstreamLock: {
      upstream: { version: string; commit: string };
      protocol: { openapiSha256: string };
    },
  ) {
    this.expectedVersion = upstreamLock.upstream.version;
    this.expectedOpenApi = upstreamLock.protocol.openapiSha256;
    this.expectedCommit = upstreamLock.upstream.commit;
    this.agentServer.on("connection", (socket) => this.handleAgent(socket));
    this.browserServer.on(
      "connection",
      (socket, request) => void this.handleBrowser(socket, request),
    );
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): boolean {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", this.config.publicOrigin);
    } catch {
      socket.destroy();
      return true;
    }
    if (url.pathname === "/ws/v1/agent") {
      if (
        !consumeRate(
          this.agentHandshakeRate,
          MAX_HANDSHAKES_PER_MINUTE,
          60_000,
        ) ||
        this.agentServer.clients.size >= MAX_AGENT_CONNECTIONS
      ) {
        socket.destroy();
        return true;
      }
      this.agentServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.agentServer.emit("connection", webSocket, request);
      });
      return true;
    }
    if (url.pathname === "/ws/v1/browser") {
      if (
        !consumeRate(
          this.browserHandshakeRate,
          MAX_HANDSHAKES_PER_MINUTE,
          60_000,
        ) ||
        this.browserServer.clients.size >= MAX_BROWSER_CONNECTIONS
      ) {
        socket.destroy();
        return true;
      }
      if (request.headers.origin !== this.config.publicOrigin.origin) {
        socket.destroy();
        return true;
      }
      const cookies = parseCookies(request.headers.cookie);
      if (
        !cookies[CSRF_COOKIE] ||
        cookies[CSRF_COOKIE] !== url.searchParams.get("csrf")
      ) {
        socket.destroy();
        return true;
      }
      this.browserServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.browserServer.emit("connection", webSocket, request);
      });
      return true;
    }
    return false;
  }

  close(): void {
    for (const connection of this.agents.values())
      connection.socket.close(1001, "server shutdown");
    for (const connection of this.browsers)
      connection.socket.close(1001, "server shutdown");
    this.agentServer.close();
    this.browserServer.close();
  }

  revokeHost(hostId: string): void {
    const connection = this.agents.get(hostId);
    if (connection) connection.socket.close(4003, "host identity revoked");
    this.agents.delete(hostId);
    this.broadcast({ type: "server.host.offline", hostId });
  }

  private handleAgent(socket: WebSocket): void {
    let connection: AgentConnection | null = null;
    const connectedAt = Date.now();
    const stopHeartbeat = installHeartbeat(socket);
    const messageRate: RateWindow = { startedAt: Date.now(), count: 0 };
    const authTimer = setTimeout(
      () => socket.close(1008, "authentication timeout"),
      10_000,
    );
    socket.on("message", (data, binary) => {
      if (
        !consumeRate(messageRate, MAX_AGENT_MESSAGES_PER_TEN_SECONDS, 10_000)
      ) {
        return socket.close(1008, "relay message rate exceeded");
      }
      if (binary || rawDataBytes(data) > MAX_FRAME_BYTES)
        return socket.close(1009, "invalid frame");
      let envelope: AgentEnvelope;
      try {
        envelope = AgentEnvelopeSchema.parse(JSON.parse(data.toString()));
      } catch {
        return socket.close(1007, "invalid envelope");
      }
      if (!connection) {
        if (envelope.type === "agent.enroll") {
          const pairing = this.db.consumePairingCode(envelope.code);
          if (!pairing) return socket.close(1008, "invalid pairing code");
          const hostId = `host_${randomUUID()}`;
          this.db.registerHost({
            hostId,
            displayName: pairing.displayName,
            mode: pairing.mode,
            platform: envelope.platform,
            publicKey: envelope.publicKey,
            agentVersion: envelope.agentVersion,
          });
          clearTimeout(authTimer);
          return sendRelayMessageAndClose(
            socket,
            {
              type: "server.enrolled",
              requestId: envelope.requestId,
              hostId,
              grantVerificationKey: this.signer.publicKeyPem,
            },
            1000,
            "enrollment complete",
          );
        }
        if (
          envelope.type !== "agent.hello" ||
          !this.verifyAgentHello(envelope)
        ) {
          return socket.close(1008, "agent authentication failed");
        }
        const compatible =
          envelope.opencodeVersion === this.expectedVersion &&
          envelope.openapiSha256 === this.expectedOpenApi &&
          envelope.upstreamCommit === this.expectedCommit;
        connection = { socket, hostId: envelope.hostId, authenticated: true };
        this.replaceAgent(connection);
        this.db.updateHostStatus({
          hostId: envelope.hostId,
          state: compatible ? "online" : "unsupported",
          agentVersion: envelope.agentVersion,
          opencodeVersion: envelope.opencodeVersion,
          openapiSha256: envelope.openapiSha256,
          upstreamCommit: envelope.upstreamCommit,
          capabilities: envelope.capabilities,
        });
        clearTimeout(authTimer);
        send(socket, {
          type: "server.hello",
          requestId: envelope.requestId,
          hostId: envelope.hostId,
          compatible,
          expected: {
            opencodeVersion: this.expectedVersion,
            openapiSha256: this.expectedOpenApi,
            upstreamCommit: this.expectedCommit,
          },
        });
        return;
      }
      this.handleAuthenticatedAgent(connection, envelope);
    });
    socket.on("close", (code) => {
      stopHeartbeat();
      logRelayClose("agent", code, connectedAt, connection ? 1 : 0);
      clearTimeout(authTimer);
      if (connection && this.agents.get(connection.hostId)?.socket === socket) {
        this.agents.delete(connection.hostId);
        this.db.markHostOffline(connection.hostId);
        for (const browser of this.browsers) {
          for (const [channelId, channel] of browser.channels) {
            if (channel.hostId === connection.hostId)
              browser.channels.delete(channelId);
          }
        }
        this.broadcast({
          type: "server.host.offline",
          hostId: connection.hostId,
        });
      }
    });
  }

  private handleAuthenticatedAgent(
    connection: AgentConnection,
    envelope: AgentEnvelope,
  ): void {
    if (
      "hostId" in envelope &&
      envelope.hostId &&
      envelope.hostId !== connection.hostId
    ) {
      return connection.socket.close(1008, "host identity mismatch");
    }
    if (envelope.type === "agent.heartbeat") {
      const current = this.db
        .listHosts()
        .find((host) => host.hostId === connection.hostId);
      const state: HostState =
        current?.state === "unsupported" ? "unsupported" : envelope.state;
      this.db.updateHostStatus({
        hostId: connection.hostId,
        state,
        agentVersion: current?.agentVersion ?? "unknown",
        opencodeVersion: envelope.opencodeVersion,
        openapiSha256: envelope.openapiSha256,
        upstreamCommit: current?.upstreamCommit ?? undefined,
        capabilities: current?.capabilities ?? [],
      });
      return send(connection.socket, {
        type: "server.heartbeat",
        sequence: envelope.sequence,
      });
    }
    if (envelope.type === "agent.session-cache") {
      this.db.replaceSessionCache(connection.hostId, envelope.sessions);
      return;
    }
    if (envelope.type === "agent.audit") {
      const browser = [...this.browsers].find(
        (candidate) =>
          candidate.channels.get(envelope.channelId)?.hostId ===
          connection.hostId,
      );
      if (!browser) return;
      this.db.audit({
        occurredAt: envelope.occurredAt,
        subject: browser.principal.subject,
        hostId: connection.hostId,
        category: envelope.category,
        outcome: envelope.outcome,
        requestId: envelope.requestId,
      });
      return;
    }
    if (
      envelope.type === "agent.channel.accept" ||
      envelope.type === "agent.frame"
    ) {
      const channelId =
        envelope.type === "agent.channel.accept"
          ? envelope.channelId
          : envelope.frame.channelId;
      return this.sendToChannel(envelope, connection.hostId, channelId);
    }
  }

  private async handleBrowser(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const principal = await this.auth.sessionFromToken(cookies[SESSION_COOKIE]);
    if (!principal) return socket.close(1008, "authentication required");
    const connection: BrowserConnection = {
      socket,
      principal,
      channels: new Map(),
    };
    const messageRate: RateWindow = { startedAt: Date.now(), count: 0 };
    const connectedAt = Date.now();
    const stopHeartbeat = installHeartbeat(socket);
    this.browsers.add(connection);
    send(socket, { type: "server.browser.ready" });
    socket.on("message", (data, binary) => {
      if (
        !consumeRate(messageRate, MAX_BROWSER_MESSAGES_PER_TEN_SECONDS, 10_000)
      ) {
        return socket.close(1008, "relay message rate exceeded");
      }
      if (binary || rawDataBytes(data) > MAX_FRAME_BYTES)
        return socket.close(1009, "invalid frame");
      let envelope;
      try {
        envelope = BrowserEnvelopeSchema.parse(JSON.parse(data.toString()));
      } catch {
        return socket.close(1007, "invalid envelope");
      }
      if (envelope.type === "browser.channel.open") {
        if (
          connection.channels.has(envelope.channelId) ||
          connection.channels.size >= MAX_CHANNELS_PER_BROWSER
        ) {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "channel_limit_reached",
          });
        }
        let grant;
        try {
          grant = this.signer.verify(envelope.grant);
        } catch {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "invalid_grant",
          });
        }
        if (
          grant.subject !== principal.subject ||
          grant.hostId !== envelope.hostId
        ) {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "grant_binding_mismatch",
          });
        }
        const allowed =
          (envelope.channel === "opencode-http" &&
            grant.scopes.some(
              (scope) => scope === "http.read" || scope === "http.write",
            )) ||
          (envelope.channel === "opencode-event" &&
            grant.scopes.includes("event.stream")) ||
          (envelope.channel === "opencode-pty" &&
            grant.scopes.includes("pty.connect"));
        if (
          !allowed ||
          !this.db.consumeNonce(grant.nonce, new Date(grant.expiresAt * 1000))
        ) {
          return send(socket, {
            type: "server.error",
            requestId: envelope.requestId,
            code: "grant_rejected",
          });
        }
        connection.channels.set(envelope.channelId, {
          hostId: envelope.hostId,
          grant: envelope.grant,
          grantId: grant.grantId,
          channel: envelope.channel,
          lastSequence: -1,
        });
      } else if (envelope.type === "browser.frame") {
        const channel = connection.channels.get(envelope.frame.channelId);
        const validationFailure = !channel
          ? "channel_missing"
          : channel.hostId !== envelope.hostId
            ? "channel_host_mismatch"
            : channel.grant !== envelope.grant
              ? "channel_grant_mismatch"
              : channel.channel !== envelope.frame.channel
                ? "channel_kind_mismatch"
                : envelope.frame.sequence <= channel.lastSequence
                  ? "channel_sequence_replay"
                  : null;
        if (validationFailure) {
          return send(socket, {
            type: "server.error",
            channelId: envelope.frame.channelId,
            code: validationFailure,
          });
        }
        if (!channel) return;
        channel.lastSequence = envelope.frame.sequence;
      } else {
        const channel = connection.channels.get(envelope.channelId);
        if (!channel || channel.hostId !== envelope.hostId) return;
        connection.channels.delete(envelope.channelId);
      }
      const agent = this.agents.get(envelope.hostId);
      if (!agent) {
        if (envelope.type === "browser.channel.close") return;
        return send(socket, {
          type: "server.error",
          requestId:
            envelope.type === "browser.channel.open"
              ? envelope.requestId
              : undefined,
          channelId:
            envelope.type === "browser.frame"
              ? envelope.frame.channelId
              : undefined,
          code: "host_offline",
        });
      }
      send(agent.socket, { ...envelope, subject: principal.subject });
    });
    socket.on("close", (code) => {
      stopHeartbeat();
      logRelayClose("browser", code, connectedAt, connection.channels.size);
      this.browsers.delete(connection);
      for (const [channelId, channel] of connection.channels) {
        const agent = this.agents.get(channel.hostId);
        if (agent)
          send(agent.socket, {
            type: "browser.channel.close",
            hostId: channel.hostId,
            channelId,
            reason: "disconnect",
          });
      }
    });
  }

  private verifyAgentHello(
    envelope: Extract<AgentEnvelope, { type: "agent.hello" }>,
  ): boolean {
    const identity = this.db.getHostIdentity(envelope.hostId);
    if (
      !identity ||
      identity.revoked ||
      Math.abs(Date.now() - envelope.timestamp) > 60_000
    )
      return false;
    if (!this.db.consumeNonce(envelope.nonce, new Date(Date.now() + 120_000)))
      return false;
    const canonical = [
      envelope.hostId,
      envelope.timestamp,
      envelope.nonce,
      envelope.agentVersion,
      envelope.opencodeVersion,
      envelope.openapiSha256,
      envelope.upstreamCommit,
      envelope.capabilities.join(","),
    ].join("\n");
    try {
      return verify(
        null,
        Buffer.from(canonical),
        createPublicKey(identity.publicKey),
        Buffer.from(envelope.signature, "base64url"),
      );
    } catch {
      return false;
    }
  }

  private replaceAgent(connection: AgentConnection): void {
    const previous = this.agents.get(connection.hostId);
    if (previous) previous.socket.close(4001, "replaced by a newer connection");
    this.agents.set(connection.hostId, connection);
    this.broadcast({ type: "server.host.online", hostId: connection.hostId });
  }

  private broadcast(payload: unknown, hostId?: string): void {
    for (const browser of this.browsers) {
      if (
        !hostId ||
        [...browser.channels.values()].some(
          (channel) => channel.hostId === hostId,
        )
      ) {
        send(browser.socket, payload);
      }
    }
  }

  private sendToChannel(
    payload: unknown,
    hostId: string,
    channelId: string,
  ): void {
    for (const browser of this.browsers) {
      if (browser.channels.get(channelId)?.hostId === hostId)
        send(browser.socket, payload);
    }
  }
}

export function newPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
