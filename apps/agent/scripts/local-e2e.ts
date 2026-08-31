import { createPublicKey, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import WebSocket from "ws";

type Kind = "opencode-http" | "opencode-event" | "opencode-pty";
type Payload = Record<string, unknown> & { type: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const origin =
  process.env.AIALRA_OPENCODE_E2E_ORIGIN ?? "http://127.0.0.1:8787";
const configuredExecutable = process.env.AIALRA_OPENCODE_E2E_BINARY;
if (!configuredExecutable || !isAbsolute(configuredExecutable))
  throw new Error(
    "AIALRA_OPENCODE_E2E_BINARY must name an absolute immutable OpenCode binary",
  );
const executable: string = configuredExecutable;

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function unbase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function childExit(child: ChildProcess, stdin?: string): Promise<string> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on(
    "data",
    (value: Buffer) => (stdout += value.toString("utf8")),
  );
  child.stderr?.on(
    "data",
    (value: Buffer) => (stderr += value.toString("utf8")),
  );
  if (stdin !== undefined) child.stdin?.end(stdin);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("exit", resolveExit);
    child.once("error", reject);
  });
  if (code !== 0)
    throw new Error(`child process failed: ${stderr.slice(0, 500)}`);
  return stdout;
}

function cookieValue(setCookies: string[], name: string): string {
  const item = setCookies
    .map((value) => value.split(";", 1)[0])
    .find((value) => value?.startsWith(`${name}=`));
  if (!item) throw new Error(`${name} cookie was not issued`);
  return item.slice(name.length + 1);
}

class BrowserChannel {
  private sendSequence = 0;
  private receiveSequence = 0;
  private readonly queue: Payload[] = [];
  private readonly waiters: Array<(value: Payload) => void> = [];

  private constructor(
    readonly id: string,
    readonly kind: Kind,
    private readonly key: Uint8Array,
    private readonly socket: WebSocket,
    private readonly hostId: string,
    private readonly grant: string,
  ) {}

  static async open(input: {
    socket: WebSocket;
    hostId: string;
    kind: Kind;
    scopes: string[];
    cookie: string;
    csrf: string;
  }): Promise<BrowserChannel> {
    const headers = {
      cookie: input.cookie,
      origin,
      "x-csrf-token": input.csrf,
      "content-type": "application/json",
    };
    const grantResponse = await fetch(`${origin}/api/v1/relay-grants`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        hostId: input.hostId,
        scopes: input.scopes,
        ttlSeconds: 300,
      }),
    });
    if (!grantResponse.ok)
      throw new Error(`grant request failed with ${grantResponse.status}`);
    const grant = String(
      ((await grantResponse.json()) as { token: string }).token,
    );
    const identityResponse = await fetch(
      `${origin}/api/v1/hosts/${encodeURIComponent(input.hostId)}/identity`,
      { headers: { cookie: input.cookie } },
    );
    if (!identityResponse.ok)
      throw new Error(
        `identity request failed with ${identityResponse.status}`,
      );
    const identityPem = String(
      ((await identityResponse.json()) as { publicKeyPem: string })
        .publicKeyPem,
    );
    const identityDer = createPublicKey(identityPem).export({
      format: "der",
      type: "spki",
    });
    const identityRaw = new Uint8Array(identityDer.subarray(-32));
    const privateKey = x25519.utils.randomSecretKey();
    const browserKey = base64url(x25519.getPublicKey(privateKey));
    const channelId = randomUUID();
    const requestId = randomUUID();
    const accepted = new Promise<Record<string, unknown>>(
      (resolveAccepted, reject) => {
        const timer = setTimeout(
          () => reject(new Error("channel acceptance timed out")),
          10_000,
        );
        const listener = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as Record<
            string,
            unknown
          >;
          if (
            message.type === "server.error" &&
            message.requestId === requestId
          ) {
            clearTimeout(timer);
            input.socket.off("message", listener);
            reject(new Error(`channel rejected: ${String(message.code)}`));
          }
          if (
            message.type === "agent.channel.accept" &&
            message.channelId === channelId
          ) {
            clearTimeout(timer);
            input.socket.off("message", listener);
            resolveAccepted(message);
          }
        };
        input.socket.on("message", listener);
      },
    );
    input.socket.send(
      JSON.stringify({
        type: "browser.channel.open",
        requestId,
        hostId: input.hostId,
        channelId,
        channel: input.kind,
        browserEphemeralKey: browserKey,
        grant,
      }),
    );
    const response = await accepted;
    const agentKey = String(response.agentEphemeralKey);
    const canonical = [
      channelId,
      browserKey,
      agentKey,
      base64url(sha256(encoder.encode(grant))),
    ].join("\n");
    if (
      !ed25519.verify(
        unbase64url(String(response.signature)),
        encoder.encode(canonical),
        identityRaw,
      )
    ) {
      throw new Error("agent channel signature verification failed");
    }
    const shared = x25519.getSharedSecret(privateKey, unbase64url(agentKey));
    const key = hkdf(
      sha256,
      shared,
      encoder.encode(channelId),
      encoder.encode("aialra-opencode-e2e-v1"),
      32,
    );
    const channel = new BrowserChannel(
      channelId,
      input.kind,
      key,
      input.socket,
      input.hostId,
      grant,
    );
    input.socket.on("message", (data) => channel.onMessage(data));
    return channel;
  }

  send(payload: Payload): void {
    const sequence = this.sendSequence++;
    const nonce = randomBytes(24);
    const aad = encoder.encode(`${this.id}\n${this.kind}\n${sequence}`);
    const sealed = xchacha20poly1305(this.key, nonce, aad).encrypt(
      encoder.encode(JSON.stringify(payload)),
    );
    this.socket.send(
      JSON.stringify({
        type: "browser.frame",
        hostId: this.hostId,
        grant: this.grant,
        frame: {
          channelId: this.id,
          channel: this.kind,
          sequence,
          nonce: base64url(nonce),
          ciphertext: base64url(sealed.slice(0, -16)),
          tag: base64url(sealed.slice(-16)),
        },
      }),
    );
  }

  async next(timeoutMs = 10_000): Promise<Payload> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise<Payload>((resolvePayload, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay payload timed out")),
        timeoutMs,
      );
      this.waiters.push((payload) => {
        clearTimeout(timer);
        resolvePayload(payload);
      });
    });
  }

  close(): void {
    this.socket.send(
      JSON.stringify({
        type: "browser.channel.close",
        hostId: this.hostId,
        channelId: this.id,
        reason: "user",
      }),
    );
  }

  private onMessage(data: WebSocket.RawData): void {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    if (message.type !== "agent.frame") return;
    const frame = message.frame as Record<string, unknown>;
    if (frame.channelId !== this.id) return;
    if (frame.channel !== this.kind || frame.sequence !== this.receiveSequence)
      throw new Error("agent frame sequence mismatch");
    const nonce = unbase64url(String(frame.nonce));
    const sealed = new Uint8Array([
      ...unbase64url(String(frame.ciphertext)),
      ...unbase64url(String(frame.tag)),
    ]);
    const aad = encoder.encode(
      `${this.id}\n${this.kind}\n${this.receiveSequence}`,
    );
    const payload = JSON.parse(
      decoder.decode(xchacha20poly1305(this.key, nonce, aad).decrypt(sealed)),
    ) as Payload;
    this.receiveSequence += 1;
    const waiter = this.waiters.shift();
    if (waiter) waiter(payload);
    else this.queue.push(payload);
  }
}

async function request(
  channel: BrowserChannel,
  input: { method: string; path: string; query?: string; body?: unknown },
): Promise<{ status: number | null; body: Buffer; error: string | null }> {
  const requestId = randomUUID();
  channel.send({
    type: "relay.http.request",
    requestId,
    method: input.method,
    path: input.path,
    query: input.query ?? "",
    headers:
      input.body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    bodyBase64:
      input.body === undefined
        ? null
        : Buffer.from(JSON.stringify(input.body)).toString("base64url"),
  });
  let status: number | null = null;
  let nextSequence = 0;
  const chunks: Buffer[] = [];
  while (true) {
    const payload = await channel.next();
    if (payload.requestId !== requestId) continue;
    if (payload.type === "relay.http.response.start")
      status = Number(payload.status);
    if (payload.type === "relay.http.chunk") {
      if (payload.sequence !== nextSequence++)
        throw new Error("HTTP response chunk sequence mismatch");
      chunks.push(Buffer.from(String(payload.bodyBase64), "base64url"));
    }
    if (payload.type === "relay.http.end")
      return {
        status,
        body: Buffer.concat(chunks),
        error: typeof payload.errorCode === "string" ? payload.errorCode : null,
      };
  }
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "aialra-opencode-e2e-"));
  const workspaceRoot = process.env.AIALRA_OPENCODE_E2E_WORKSPACE ?? temporary;
  const displayName = process.env.AIALRA_OPENCODE_E2E_NAME ?? "Local E2E";
  const mode =
    process.env.AIALRA_OPENCODE_E2E_MODE === "vps" ? "vps" : "remote";
  const configPath = join(temporary, "agent.json");
  let agent: ChildProcess | null = null;
  let socket: WebSocket | null = null;
  try {
    const me = await fetch(`${origin}/api/v1/me`);
    if (!me.ok)
      throw new Error(`development authentication failed with ${me.status}`);
    const setCookies = me.headers.getSetCookie();
    const csrf = cookieValue(setCookies, "aialra_csrf");
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const pairing = await fetch(`${origin}/api/v1/pairing-codes`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName, mode }),
    });
    if (!pairing.ok)
      throw new Error(`pairing request failed with ${pairing.status}`);
    const code = String(((await pairing.json()) as { code: string }).code);
    const lock = JSON.parse(
      await readFile(join(repo, "upstream.lock.json"), "utf8"),
    ) as {
      upstream: { version: string; commit: string };
      protocol: { openapiSha256: string };
    };
    await childExit(
      spawn(
        process.execPath,
        [
          join(repo, "apps/agent/dist/main.js"),
          "enroll",
          "--server",
          origin,
          "--pairing-code-file",
          "-",
          "--name",
          displayName,
          "--mode",
          mode,
          "--opencode",
          executable,
          "--upstream-commit",
          lock.upstream.commit,
          "--expected-version",
          lock.upstream.version,
          "--openapi-sha256",
          lock.protocol.openapiSha256,
          "--manifest",
          join(repo, "generated/route-capabilities.json"),
          "--workspace-root",
          workspaceRoot,
          "--workspace-label",
          `${displayName} workspace`,
          "--config",
          configPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      ),
      code,
    );
    agent = spawn(
      process.execPath,
      [join(repo, "apps/agent/dist/main.js"), "run", "--config", configPath],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    let agentError = "";
    agent.stderr?.on("data", (value: Buffer) => {
      const text = value.toString("utf8");
      agentError += text;
      if (process.env.AIALRA_OPENCODE_E2E_HOLD === "1")
        process.stderr.write(text);
    });
    let hostId = "";
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const hostsResponse = await fetch(`${origin}/api/v1/hosts`, {
        headers: { cookie },
      });
      const hosts = (
        (await hostsResponse.json()) as {
          hosts: Array<{
            hostId: string;
            displayName: string;
            state: string;
            opencodeVersion: string | null;
          }>;
        }
      ).hosts;
      const host = hosts.find(
        (candidate) =>
          candidate.displayName === displayName && candidate.state === "online",
      );
      if (host) {
        if (host.opencodeVersion !== lock.upstream.version)
          throw new Error("actual OpenCode host version readback mismatched");
        hostId = host.hostId;
        break;
      }
      if (agent.exitCode !== null)
        throw new Error(
          `agent exited before online: ${agentError.slice(0, 500)}`,
        );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    if (!hostId)
      throw new Error(
        `agent did not become online: ${agentError.slice(0, 500)}`,
      );
    if (process.env.AIALRA_OPENCODE_E2E_BROWSER_ONLY === "1") {
      process.stdout.write(
        `${JSON.stringify({ browserReady: true, versionReadback: lock.upstream.version })}\n`,
      );
      await new Promise<void>((resolveHold) => {
        process.once("SIGINT", resolveHold);
        process.once("SIGTERM", resolveHold);
        process.stdin.resume();
        process.stdin.once("end", resolveHold);
      });
      return;
    }
    const wsUrl = new URL(origin);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws/v1/browser";
    wsUrl.searchParams.set("csrf", csrf);
    socket = new WebSocket(wsUrl, { headers: { cookie, origin } });
    const socketOpened = new Promise<void>((resolveOpen, reject) => {
      socket!.once("open", resolveOpen);
      socket!.once("error", reject);
    });
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error("browser relay readiness timed out")),
        10_000,
      );
      socket!.on("message", function ready(data) {
        const value = JSON.parse(data.toString()) as { type?: string };
        if (value.type !== "server.browser.ready") return;
        clearTimeout(timer);
        socket!.off("message", ready);
        resolveReady();
      });
    });
    await Promise.all([socketOpened, ready]);

    const http = await BrowserChannel.open({
      socket,
      hostId,
      kind: "opencode-http",
      scopes: ["http.read", "http.write"],
      cookie,
      csrf,
    });
    const health = await request(http, {
      method: "GET",
      path: "/global/health",
    });
    if (
      health.status !== 200 ||
      health.error ||
      !health.body.toString("utf8").includes("healthy")
    )
      throw new Error("encrypted HTTP health probe failed");
    const denied = await request(http, {
      method: "GET",
      path: "/proxy/127.0.0.1",
    });
    if (denied.status !== null || !denied.error)
      throw new Error("unknown route was not rejected before loopback access");

    const escaped = await request(http, {
      method: "GET",
      path: "/path",
      query: `directory=${encodeURIComponent(join(tmpdir(), `${displayName}-outside-workspace`))}`,
    });
    if (
      escaped.status !== null ||
      escaped.error !== "workspace_boundary_rejected"
    )
      throw new Error("workspace boundary did not reject an escaped directory");

    const event = await BrowserChannel.open({
      socket,
      hostId,
      kind: "opencode-event",
      scopes: ["event.stream"],
      cookie,
      csrf,
    });
    const eventRequestId = randomUUID();
    event.send({
      type: "relay.http.request",
      requestId: eventRequestId,
      method: "GET",
      path: "/global/event",
      query: "",
      headers: { accept: "text/event-stream" },
      bodyBase64: null,
    });
    let eventStarted = false;
    let eventChunk = false;
    for (let attempt = 0; attempt < 20 && !eventChunk; attempt += 1) {
      const payload = await event.next();
      if (payload.requestId !== eventRequestId) continue;
      if (
        payload.type === "relay.http.response.start" &&
        payload.status === 200
      )
        eventStarted = true;
      if (
        payload.type === "relay.http.chunk" &&
        String(payload.bodyBase64).length > 0
      )
        eventChunk = true;
    }
    event.send({ type: "relay.http.cancel", requestId: eventRequestId });
    if (!eventStarted || !eventChunk)
      throw new Error("SSE did not produce a streamed event");

    const ptyCreated = await request(http, {
      method: "POST",
      path: "/pty",
      body: {},
    });
    if (ptyCreated.status !== 200 || ptyCreated.error)
      throw new Error(
        `PTY creation failed: status=${ptyCreated.status} error=${ptyCreated.error ?? "none"} body=${ptyCreated.body.toString("utf8").slice(0, 500)}`,
      );
    const ptyId = String(
      (JSON.parse(ptyCreated.body.toString("utf8")) as { id: string }).id,
    );
    const pty = await BrowserChannel.open({
      socket,
      hostId,
      kind: "opencode-pty",
      scopes: ["pty.connect"],
      cookie,
      csrf,
    });
    const socketId = randomUUID();
    pty.send({
      type: "relay.socket.open",
      socketId,
      path: `/pty/${encodeURIComponent(ptyId)}/connect`,
      query: "",
      protocols: [],
    });
    let opened = false;
    for (let attempt = 0; attempt < 10 && !opened; attempt += 1) {
      const payload = await pty.next();
      if (payload.type === "relay.socket.open" && payload.socketId === socketId)
        opened = true;
    }
    if (!opened) throw new Error("PTY WebSocket relay did not open");
    pty.send({
      type: "relay.socket.data",
      socketId,
      sequence: 0,
      binary: false,
      dataBase64: Buffer.from(
        "Write-Output AIALRA_PTY_OK\r\nexit\r\n",
      ).toString("base64url"),
    });
    let terminal = "";
    for (
      let attempt = 0;
      attempt < 40 && !terminal.includes("AIALRA_PTY_OK");
      attempt += 1
    ) {
      const payload = await pty.next(15_000);
      if (payload.type === "relay.socket.data" && payload.socketId === socketId)
        terminal += Buffer.from(
          String(payload.dataBase64),
          "base64url",
        ).toString("utf8");
      if (
        payload.type === "relay.socket.close" &&
        !terminal.includes("AIALRA_PTY_OK")
      )
        break;
    }
    if (!terminal.includes("AIALRA_PTY_OK"))
      throw new Error("PTY data round trip failed");
    await request(http, {
      method: "DELETE",
      path: `/pty/${encodeURIComponent(ptyId)}`,
    });

    if (process.env.AIALRA_OPENCODE_E2E_HOLD === "1") {
      process.stdout.write(
        `${JSON.stringify({ browserReady: true, versionReadback: lock.upstream.version })}\n`,
      );
      await new Promise<void>((resolveHold) => {
        process.once("SIGINT", resolveHold);
        process.once("SIGTERM", resolveHold);
        process.stdin.resume();
        process.stdin.once("end", resolveHold);
      });
    }
    pty.close();
    event.close();
    http.close();
    process.stdout.write(
      `${JSON.stringify({ http: true, sse: true, pty: true, routeRejection: true, versionReadback: lock.upstream.version })}\n`,
    );
  } finally {
    socket?.close(1000, "test complete");
    if (agent && agent.exitCode === null) {
      agent.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => agent!.once("exit", resolveExit)),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
      ]);
      if (agent.exitCode === null) agent.kill("SIGKILL");
    }
    const expectedPrefix = join(tmpdir(), "aialra-opencode-e2e-");
    if (!temporary.startsWith(expectedPrefix))
      throw new Error("temporary cleanup target escaped its prefix");
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}

await main();
