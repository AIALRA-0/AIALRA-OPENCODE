import type { BrowserRelay, RelayChannel, RelayPayload } from "./relay";
import { base64url, decoder, encoder, unbase64url } from "./codec";
import { virtualOrigin } from "./remote-fetch";

const VIRTUAL_SUFFIX = ".aialra.invalid";

export function installRemoteWebSocket(
  relay: BrowserRelay,
  hostIds: string[],
): () => void {
  const NativeWebSocket = globalThis.WebSocket;
  const sockets = new Set<RemoteWebSocket>();
  const hosts = new Map(
    hostIds.map((hostId) => [new URL(virtualOrigin(hostId)).hostname, hostId]),
  );

  class RemoteWebSocket extends EventTarget implements WebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    readyState = RemoteWebSocket.CONNECTING;
    onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
    private readonly socketId = crypto.randomUUID();
    private channel: RelayChannel | null = null;
    private stopListening: (() => void) | null = null;
    private sendSequence = 0;
    private reconnectAttempts = 0;
    private reconnectTimer: number | undefined;
    private hostId = "";
    private path = "";
    private query = new URLSearchParams();
    private protocols: string[] = [];
    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      sockets.add(this);
      this.url = String(url);
      const parsed = new URL(this.url, location.href);
      if (!parsed.hostname.endsWith(VIRTUAL_SUFFIX)) {
        queueMicrotask(() => this.fail());
        return;
      }
      const hostId = hosts.get(parsed.hostname);
      if (
        !hostId ||
        (parsed.protocol !== "wss:" && parsed.protocol !== "https:")
      ) {
        queueMicrotask(() => this.fail());
        return;
      }
      const list = Array.isArray(protocols)
        ? protocols
        : protocols
          ? [protocols]
          : [];
      this.hostId = hostId;
      this.path = parsed.pathname;
      this.query = parsed.searchParams;
      this.protocols = list;
      this.connect();
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== RemoteWebSocket.OPEN || !this.channel)
        throw new DOMException("WebSocket is not open", "InvalidStateError");
      const sequence = this.sendSequence++;
      const sendBytes = (bytes: Uint8Array, binary: boolean) => {
        void this.channel
          ?.send({
            type: "relay.socket.data",
            socketId: this.socketId,
            sequence,
            binary,
            dataBase64: base64url(bytes),
          })
          .catch(() => this.scheduleReconnect());
      };
      if (typeof data === "string") void sendBytes(encoder.encode(data), false);
      else if (data instanceof Blob)
        void data
          .arrayBuffer()
          .then((value) => sendBytes(new Uint8Array(value), true));
      else if (ArrayBuffer.isView(data))
        void sendBytes(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          true,
        );
      else void sendBytes(new Uint8Array(data), true);
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState >= RemoteWebSocket.CLOSING) return;
      this.readyState = RemoteWebSocket.CLOSING;
      if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
      void this.channel?.send({
        type: "relay.socket.close",
        socketId: this.socketId,
        code,
        reason,
      });
      this.finish(code, reason);
    }

    private connect(): void {
      if (this.readyState >= RemoteWebSocket.CLOSING) return;
      this.readyState = RemoteWebSocket.CONNECTING;
      this.stopListening?.();
      this.stopListening = null;
      this.channel = null;
      void relay
        .channel(this.hostId, "opencode-pty", ["pty.connect"])
        .then((channel) => {
          if (this.readyState >= RemoteWebSocket.CLOSING) return;
          this.channel = channel;
          this.stopListening = channel.listen((payload) =>
            this.onPayload(payload),
          );
          return channel.send({
            type: "relay.socket.open",
            socketId: this.socketId,
            path: this.path,
            query: this.query.toString(),
            protocols: this.protocols,
          });
        })
        .catch(() => this.scheduleReconnect());
    }

    private scheduleReconnect(): void {
      if (
        this.readyState >= RemoteWebSocket.CLOSING ||
        this.reconnectTimer !== undefined
      )
        return;
      this.readyState = RemoteWebSocket.CONNECTING;
      this.stopListening?.();
      this.stopListening = null;
      this.channel = null;
      const delay = Math.min(
        250 * 2 ** Math.min(this.reconnectAttempts, 4),
        4_000,
      );
      this.reconnectAttempts += 1;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, delay);
    }

    private onPayload(payload: RelayPayload): void {
      if (payload.type === "relay.disconnected") {
        this.scheduleReconnect();
        return;
      }
      if (payload.socketId !== this.socketId) return;
      if (payload.type === "relay.socket.open") {
        this.readyState = RemoteWebSocket.OPEN;
        this.reconnectAttempts = 0;
        this.sendSequence = 0;
        const event = new Event("open");
        this.dispatchEvent(event);
        this.onopen?.call(this as unknown as WebSocket, event);
        return;
      }
      if (payload.type === "relay.socket.data") {
        const bytes = unbase64url(String(payload.dataBase64));
        const binary = Boolean(payload.binary);
        if (binary && bytes[0] === 0) {
          try {
            const metadata = JSON.parse(decoder.decode(bytes.subarray(1))) as {
              cursor?: unknown;
            };
            if (
              typeof metadata.cursor === "number" &&
              Number.isSafeInteger(metadata.cursor) &&
              metadata.cursor >= 0
            )
              this.query.set("cursor", String(metadata.cursor));
          } catch {
            // The official terminal validates the control frame itself
          }
        }
        const data = binary
          ? this.binaryType === "arraybuffer"
            ? bytes.slice().buffer
            : new Blob([bytes.slice().buffer])
          : decoder.decode(bytes);
        const event = new MessageEvent("message", { data });
        this.dispatchEvent(event);
        this.onmessage?.call(this as unknown as WebSocket, event);
        return;
      }
      if (payload.type === "relay.socket.close") {
        const code = Number(payload.code);
        if (code === 4403 && this.query.has("ticket")) {
          this.query.delete("ticket");
          this.scheduleReconnect();
          return;
        }
        if (code === 4404 || code === 4410) {
          this.finishWhenHttpReady(code, String(payload.reason));
          return;
        }
        this.finish(code, String(payload.reason));
      }
    }

    private finishWhenHttpReady(code: number, reason: string): void {
      if (this.readyState >= RemoteWebSocket.CLOSING) return;
      this.readyState = RemoteWebSocket.CONNECTING;
      void relay
        .channel(this.hostId, "opencode-http", ["http.read", "http.write"])
        .then(() => this.finish(code, reason))
        .catch(() => {
          if (this.readyState >= RemoteWebSocket.CLOSING) return;
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.finishWhenHttpReady(code, reason);
          }, 500);
        });
    }

    private fail(): void {
      const event = new Event("error");
      this.dispatchEvent(event);
      this.onerror?.call(this as unknown as WebSocket, event);
      this.finish(1006, "relay connection failed");
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === RemoteWebSocket.CLOSED) return;
      this.readyState = RemoteWebSocket.CLOSED;
      if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.stopListening?.();
      this.stopListening = null;
      this.channel = null;
      sockets.delete(this);
      const event = new CloseEvent("close", {
        code,
        reason,
        wasClean: code === 1000,
      });
      this.dispatchEvent(event);
      this.onclose?.call(this as unknown as WebSocket, event);
    }
  }

  globalThis.WebSocket = RemoteWebSocket as unknown as typeof WebSocket;
  return () => {
    for (const socket of [...sockets])
      socket.close(1000, "application disposed");
    sockets.clear();
    if (
      globalThis.WebSocket === (RemoteWebSocket as unknown as typeof WebSocket)
    )
      globalThis.WebSocket = NativeWebSocket;
  };
}
