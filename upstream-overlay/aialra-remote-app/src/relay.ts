import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hostIdentity, relayGrant, csrfToken } from "./api";
import { base64url, decoder, encoder, pemRawKey, unbase64url } from "./codec";
import { nextRelayRetryState, type RelayRetryState } from "./relay-retry";

export type ChannelKind = "opencode-http" | "opencode-event" | "opencode-pty";
export type RelayPayload = Record<string, unknown> & { type: string };

interface EncryptedFrame {
  channelId: string;
  channel: ChannelKind;
  sequence: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface ChannelState {
  hostId: string;
  channelId: string;
  openRequestId: string;
  channel: ChannelKind;
  scopes: string[];
  privateKey: Uint8Array;
  browserPublicKey: string;
  grant: string;
  grantExpiresAt: number;
  renewAt: number;
  identityKey: Uint8Array;
  key: Uint8Array | null;
  sendSequence: number;
  receiveSequence: number;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  listeners: Set<(payload: RelayPayload) => void>;
}

const NativeWebSocket = globalThis.WebSocket;

export class BrowserRelay {
  private socket: WebSocket | null = null;
  private socketReady: Promise<void> | null = null;
  private readonly channels = new Map<string, ChannelState>();
  private readonly reusable = new Map<string, Promise<RelayChannel>>();
  private readonly identities = new Map<string, Promise<string>>();
  private readonly failures = new Map<string, RelayRetryState>();
  private disposed = false;

  async channel(
    hostId: string,
    kind: ChannelKind,
    scopes: string[],
  ): Promise<RelayChannel> {
    if (this.disposed) throw new Error("relay is disposed");
    const key = `${hostId}:${kind}`;
    for (;;) {
      const current = this.reusable.get(key);
      if (!current) {
        await this.waitForRetry(key);
        if (this.reusable.has(key)) continue;
        const created = this.open(hostId, kind, scopes)
          .then((channel) => {
            this.failures.delete(key);
            return channel;
          })
          .catch((error) => {
            if (this.reusable.get(key) === created) this.reusable.delete(key);
            this.failures.set(
              key,
              nextRelayRetryState(this.failures.get(key), Date.now()),
            );
            console.error(
              `[AIALRA relay] ${error instanceof Error ? error.message : "channel setup failed"}`,
            );
            throw error;
          });
        this.reusable.set(key, created);
        return created;
      }
      try {
        const resolved = await current;
        if (!resolved.expiresSoon()) return resolved;
        if (this.reusable.get(key) !== current) continue;
        await this.waitForRetry(key);
        if (this.reusable.get(key) !== current) continue;
        const replacement = this.open(hostId, kind, scopes)
          .then((channel) => {
            this.failures.delete(key);
            return channel;
          })
          .catch((error) => {
            if (this.reusable.get(key) === replacement)
              this.reusable.delete(key);
            this.failures.set(
              key,
              nextRelayRetryState(this.failures.get(key), Date.now()),
            );
            console.error(
              `[AIALRA relay] ${error instanceof Error ? error.message : "channel setup failed"}`,
            );
            throw error;
          });
        this.reusable.set(key, replacement);
        resolved.close();
        return replacement;
      } catch (error) {
        if (this.reusable.get(key) === current) this.reusable.delete(key);
        throw error;
      }
    }
  }

  private async waitForRetry(key: string): Promise<void> {
    const retryAt = this.failures.get(key)?.retryAt ?? 0;
    const remaining = retryAt - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }

  private identity(hostId: string): Promise<string> {
    const current = this.identities.get(hostId);
    if (current) return current;
    const created = hostIdentity(hostId).catch((error) => {
      if (this.identities.get(hostId) === created)
        this.identities.delete(hostId);
      throw error;
    });
    this.identities.set(hostId, created);
    return created;
  }

  private async open(
    hostId: string,
    channel: ChannelKind,
    scopes: string[],
  ): Promise<RelayChannel> {
    await this.connect();
    const [grantResult, identityPem] = await Promise.all([
      relayGrant(hostId, scopes),
      this.identity(hostId),
    ]);
    const grant = grantResult.token;
    const grantExpiresAt = Date.parse(grantResult.expiresAt);
    if (!Number.isFinite(grantExpiresAt))
      throw new Error("capability grant expiry is invalid");
    const now = Date.now();
    const grantTtl = grantExpiresAt - now;
    if (grantTtl < 60_000 || grantTtl > 360_000)
      throw new Error("capability grant expiry is outside the expected window");
    const renewAt = Math.min(grantExpiresAt - 30_000, now + 240_000);
    console.info(
      `[AIALRA relay] ${channel} grant valid for ${Math.round(grantTtl / 1000)} seconds`,
    );
    const privateKey = x25519.utils.randomSecretKey();
    const browserPublicKey = base64url(x25519.getPublicKey(privateKey));
    const channelId = crypto.randomUUID();
    const openRequestId = crypto.randomUUID();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state: ChannelState = {
      hostId,
      channelId,
      openRequestId,
      channel,
      scopes,
      privateKey,
      browserPublicKey,
      grant,
      grantExpiresAt,
      renewAt,
      identityKey: pemRawKey(identityPem),
      key: null,
      sendSequence: 0,
      receiveSequence: 0,
      ready,
      resolveReady,
      rejectReady,
      listeners: new Set(),
    };
    this.channels.set(channelId, state);
    this.send({
      type: "browser.channel.open",
      requestId: openRequestId,
      hostId,
      channelId,
      channel,
      browserEphemeralKey: browserPublicKey,
      grant,
    });
    await Promise.race([
      ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent channel timed out")), 10_000),
      ),
    ]);
    return new RelayChannel(this, state);
  }

  async transmit(state: ChannelState, payload: RelayPayload): Promise<void> {
    await state.ready;
    if (this.socket?.readyState !== NativeWebSocket.OPEN) {
      this.reusable.delete(`${state.hostId}:${state.channel}`);
      const replacement = await this.channel(
        state.hostId,
        state.channel,
        state.scopes,
      );
      const listeners = new Set(state.listeners);
      state.listeners.clear();
      replacement.copyListeners(listeners);
      this.close(state);
      return replacement.send(payload);
    }
    if (!state.key) throw new Error("channel key is unavailable");
    const sequence = state.sendSequence++;
    const nonce = randomBytes(24);
    const aad = encoder.encode(
      `${state.channelId}\n${state.channel}\n${sequence}`,
    );
    const sealed = xchacha20poly1305(state.key, nonce, aad).encrypt(
      encoder.encode(JSON.stringify(payload)),
    );
    const frame: EncryptedFrame = {
      channelId: state.channelId,
      channel: state.channel,
      sequence,
      nonce: base64url(nonce),
      ciphertext: base64url(sealed.slice(0, -16)),
      tag: base64url(sealed.slice(-16)),
    };
    this.send({
      type: "browser.frame",
      hostId: state.hostId,
      grant: state.grant,
      frame,
    });
  }

  close(state: ChannelState): void {
    if (!this.channels.delete(state.channelId)) return;
    for (const listener of state.listeners)
      listener({ type: "relay.disconnected" });
    state.listeners.clear();
    if (this.socket?.readyState === NativeWebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: "browser.channel.close",
          hostId: state.hostId,
          channelId: state.channelId,
          reason: "user",
        }),
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of [...this.channels.values()]) this.close(state);
    this.channels.clear();
    this.reusable.clear();
    this.identities.clear();
    this.failures.clear();
    this.socketReady = null;
    this.socket?.close(1000, "application disposed");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.socket?.readyState === NativeWebSocket.OPEN) return;
    if (this.socketReady) return this.socketReady;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    this.socketReady = new Promise<void>((resolve, reject) => {
      const socket = new NativeWebSocket(
        `${scheme}//${location.host}/ws/v1/browser?csrf=${encodeURIComponent(csrfToken())}`,
      );
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new Error("relay connection timed out"));
        socket.close();
      }, 10_000);
      socket.addEventListener(
        "error",
        () => reject(new Error("relay connection failed")),
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        const raw = String(event.data);
        try {
          const message = JSON.parse(raw) as Record<string, unknown>;
          if (message.type === "server.browser.ready") {
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch {
          return;
        }
        void this.onMessage(raw);
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        this.socket = null;
        this.socketReady = null;
        for (const state of this.channels.values()) {
          state.rejectReady(new Error("relay disconnected"));
          for (const listener of state.listeners)
            listener({ type: "relay.disconnected" });
        }
        this.channels.clear();
        this.reusable.clear();
        if (!this.disposed)
          console.error("[AIALRA relay] control connection closed");
      });
    });
    return this.socketReady;
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== NativeWebSocket.OPEN)
      throw new Error("relay is not connected");
    this.socket.send(JSON.stringify(payload));
  }

  private async onMessage(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "server.error") {
      const code = String(message.code ?? "unknown");
      const requestId =
        typeof message.requestId === "string" ? message.requestId : "";
      const opened = [...this.channels.values()].find(
        (candidate) => candidate.openRequestId === requestId,
      );
      const channelId =
        typeof message.channelId === "string" ? message.channelId : "";
      const state = opened ?? this.channels.get(channelId);
      if (state) {
        this.channels.delete(state.channelId);
        this.reusable.delete(`${state.hostId}:${state.channel}`);
        state.rejectReady(new Error(`relay channel rejected: ${code}`));
        for (const listener of state.listeners)
          listener({ type: "relay.disconnected" });
      } else if (code === "channel_missing") {
        // Browser WebSocket only accepts 1000 or 3000-4999 for application
        // initiated closes; 1012 is a server-only status and raises a page
        // error in Chromium instead of allowing the reconnect path to run.
        this.socket?.close(4002, "relay channel state mismatch");
      }
      console.error(
        `[AIALRA relay] server rejected a relay operation: ${code}`,
      );
      return;
    }
    if (message.type === "server.host.offline") {
      const hostId = String(message.hostId ?? "");
      for (const state of [...this.channels.values()]) {
        if (state.hostId !== hostId) continue;
        this.channels.delete(state.channelId);
        this.reusable.delete(`${state.hostId}:${state.channel}`);
        state.rejectReady(new Error("host disconnected"));
        for (const listener of state.listeners)
          listener({ type: "relay.disconnected" });
      }
      return;
    }
    if (message.type === "agent.channel.accept") {
      const state = this.channels.get(String(message.channelId));
      if (!state) return;
      const agentPublicKey = String(message.agentEphemeralKey);
      const canonical = [
        state.channelId,
        state.browserPublicKey,
        agentPublicKey,
        base64url(sha256(encoder.encode(state.grant))),
      ].join("\n");
      if (
        !ed25519.verify(
          unbase64url(String(message.signature)),
          encoder.encode(canonical),
          state.identityKey,
        )
      ) {
        this.identities.delete(state.hostId);
        state.rejectReady(new Error("agent channel signature is invalid"));
        return;
      }
      const shared = x25519.getSharedSecret(
        state.privateKey,
        unbase64url(agentPublicKey),
      );
      state.key = hkdf(
        sha256,
        shared,
        encoder.encode(state.channelId),
        encoder.encode("aialra-opencode-e2e-v1"),
        32,
      );
      console.info(`[AIALRA relay] ${state.channel} channel ready`);
      state.resolveReady();
      return;
    }
    if (message.type !== "agent.frame") return;
    const frame = message.frame as EncryptedFrame;
    const state = this.channels.get(frame.channelId);
    if (
      !state?.key ||
      frame.channel !== state.channel ||
      frame.sequence !== state.receiveSequence
    )
      return;
    try {
      const aad = encoder.encode(
        `${frame.channelId}\n${frame.channel}\n${frame.sequence}`,
      );
      const sealed = new Uint8Array([
        ...unbase64url(frame.ciphertext),
        ...unbase64url(frame.tag),
      ]);
      const value = JSON.parse(
        decoder.decode(
          xchacha20poly1305(state.key, unbase64url(frame.nonce), aad).decrypt(
            sealed,
          ),
        ),
      ) as RelayPayload;
      state.receiveSequence += 1;
      for (const listener of state.listeners) listener(value);
    } catch {
      this.close(state);
    }
  }
}

export class RelayChannel {
  constructor(
    private readonly relay: BrowserRelay,
    private readonly state: ChannelState,
  ) {}

  send(payload: RelayPayload): Promise<void> {
    return this.relay.transmit(this.state, payload);
  }

  listen(listener: (payload: RelayPayload) => void): () => void {
    this.state.listeners.add(listener);
    return () => this.state.listeners.delete(listener);
  }

  copyListeners(listeners: Set<(payload: RelayPayload) => void>): void {
    for (const listener of listeners) this.state.listeners.add(listener);
  }

  expiresSoon(now = Date.now()): boolean {
    return this.state.renewAt <= now;
  }

  close(): void {
    this.relay.close(this.state);
  }
}
