import type { BrowserRelay, RelayChannel, RelayPayload } from "./relay";
import { sha256 } from "@noble/hashes/sha2.js";
import { base32lower, base64url, encoder, unbase64url } from "./codec";

const VIRTUAL_SUFFIX = ".opencode.invalid";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "if-none-match",
  "x-opencode-directory",
  "x-opencode-project",
  "x-opencode-protocol",
  "x-opencode-ticket",
]);

interface PendingResponse {
  resolve(response: Response): void;
  reject(error: Error): void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  nextSequence: number;
  started: boolean;
  cancel(): void;
  cleanup(): void;
}

function registeredHost(url: URL, hosts: ReadonlyMap<string, string>): string {
  if (url.protocol !== "https:" || !url.hostname.endsWith(VIRTUAL_SUFFIX))
    throw new TypeError("unregistered OpenCode server");
  const hostId = hosts.get(url.hostname);
  if (!hostId) throw new TypeError("unregistered OpenCode host");
  if (url.username || url.password || url.port)
    throw new TypeError(
      "virtual OpenCode URLs cannot contain credentials or ports",
    );
  return hostId;
}

function filteredHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (ALLOWED_REQUEST_HEADERS.has(normalized)) result[normalized] = value;
  }
  return result;
}

export function virtualOrigin(hostId: string): string {
  if (hostId.length < 8 || hostId.length > 128)
    throw new TypeError("invalid host id");
  return `https://h-${base32lower(sha256(encoder.encode(hostId)))}${VIRTUAL_SUFFIX}`;
}

export function createRemoteFetch(
  relay: BrowserRelay,
  hostIds: string[],
): typeof fetch {
  const hosts = new Map(
    hostIds.map((hostId) => [new URL(virtualOrigin(hostId)).hostname, hostId]),
  );
  const pending = new Map<string, PendingResponse>();
  const listening = new WeakSet<RelayChannel>();

  const channelFor = async (hostId: string, event: boolean) => {
    const channel = event
      ? relay.channel(hostId, "opencode-event", ["event.stream"])
      : relay.channel(hostId, "opencode-http", ["http.read", "http.write"]);
    const resolved = await channel;
    if (!listening.has(resolved)) {
      resolved.listen(onPayload);
      listening.add(resolved);
    }
    return resolved;
  };

  const onPayload = (payload: RelayPayload) => {
    if (payload.type === "relay.disconnected") {
      for (const [requestId, item] of pending) {
        const error = new Error("relay disconnected");
        if (item.started) item.controller?.error(error);
        else item.reject(error);
        item.cleanup();
        pending.delete(requestId);
      }
      return;
    }
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : "";
    const item = pending.get(requestId);
    if (!item) return;
    if (payload.type === "relay.http.response.start") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          item.controller = controller;
        },
        cancel() {
          item.cancel();
        },
      });
      item.started = true;
      item.resolve(
        new Response(stream, {
          status: Number(payload.status),
          headers: new Headers(payload.headers as Record<string, string>),
        }),
      );
      return;
    }
    if (payload.type === "relay.http.chunk") {
      const sequence = Number(payload.sequence);
      if (!item.started || sequence !== item.nextSequence) {
        item.controller?.error(new Error("relay response sequence mismatch"));
        pending.delete(requestId);
        item.cleanup();
        return;
      }
      item.nextSequence += 1;
      item.controller?.enqueue(unbase64url(String(payload.bodyBase64)));
      return;
    }
    if (payload.type === "relay.http.end") {
      const errorCode =
        typeof payload.errorCode === "string" ? payload.errorCode : null;
      if (errorCode) {
        const error = new Error(`relay request failed: ${errorCode}`);
        console.error(`[AIALRA relay] request failed: ${errorCode}`);
        if (item.started) item.controller?.error(error);
        else item.reject(error);
      } else if (item.started) item.controller?.close();
      else item.reject(new Error("relay response ended before headers"));
      pending.delete(requestId);
      item.cleanup();
    }
  };

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const hostId = registeredHost(url, hosts);
    if (url.pathname.includes("..") || /%2e/i.test(url.pathname))
      throw new TypeError("path traversal is not allowed");
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : new Uint8Array(await request.arrayBuffer());
    if (body && body.byteLength > MAX_REQUEST_BYTES)
      throw new TypeError("request body exceeds the relay limit");
    const requestId = crypto.randomUUID();
    const event = url.pathname === "/event" || url.pathname.endsWith("/event");
    const channel = await channelFor(hostId, event);
    const cancel = () => {
      const item = pending.get(requestId);
      if (!item) return;
      pending.delete(requestId);
      item.controller?.error(
        new DOMException("The operation was aborted", "AbortError"),
      );
      item.reject(new DOMException("The operation was aborted", "AbortError"));
      void channel.send({ type: "relay.http.cancel", requestId });
    };
    const cleanup = () => request.signal.removeEventListener("abort", cancel);
    const response = new Promise<Response>((resolve, reject) => {
      pending.set(requestId, {
        resolve,
        reject,
        controller: null,
        nextSequence: 0,
        started: false,
        cancel,
        cleanup,
      });
    });
    request.signal.addEventListener("abort", cancel, { once: true });
    await channel.send({
      type: "relay.http.request",
      requestId,
      method: request.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: filteredHeaders(request.headers),
      bodyBase64: body ? base64url(body) : null,
    });
    return response;
  };
}
