import type { BrowserRelay, RelayChannel, RelayPayload } from "./relay";
import { sha256 } from "@noble/hashes/sha2.js";
import { base32lower, base64url, encoder, unbase64url } from "./codec";
import {
  dispatchRemoteRequestEvent,
  operationFor,
  RemoteFetchError,
  type RemoteErrorCategory,
} from "./action-state";

// This reserved suffix is intercepted by the relay and never resolved on the
// network; keeping it separate from the upstream OpenCode suffix prevents
// internal server keys from appearing as official server URLs in the UI
const VIRTUAL_SUFFIX = ".aialra.invalid";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_CACHE_BYTES = 2 * 1024 * 1024;
const METADATA_CACHE_TTL_MS = 800;
const METADATA_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 60_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "if-none-match",
  "x-opencode-directory",
  "x-opencode-project",
  "x-opencode-protocol",
  "x-opencode-ticket",
]);
const SAFE_METADATA_PATHS = new Set([
  "/path",
  "/project",
  "/api/project",
  "/session",
  "/api/session",
  "/api/agent",
  "/provider",
  "/config/providers",
  "/global/health",
  "/command",
]);

export interface RemoteFetchMetrics {
  requests: number;
  completed: number;
  failed: number;
  cacheHits: number;
  deduplicated: number;
  timeouts: number;
  aborted: number;
  channelTimeouts: number;
  upstreamTimeouts: number;
  unknownWrites: number;
}

export type RemoteFetch = typeof fetch & {
  prewarm(hostIds?: readonly string[]): Promise<void>;
  readMetrics(): RemoteFetchMetrics;
  dispose(): void;
};

interface RequestAttempt {
  requestId: string;
  hostId: string;
  method: string;
  operation: ReturnType<typeof operationFor>;
  channelReady: boolean;
  sent: boolean;
}

interface PendingResponse {
  resolve(response: Response): void;
  reject(error: Error): void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  nextSequence: number;
  started: boolean;
  cancel(): void;
  cleanup(): void;
  attempt: RequestAttempt;
}

interface ResponseSnapshot {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

interface SharedRequest {
  controller: AbortController;
  promise: Promise<ResponseSnapshot>;
  consumers: Set<symbol>;
  settled: boolean;
}

export interface RemoteFetchOptions {
  /** Test-only timing overrides; production callers use the conservative defaults. */
  metadataTimeoutMs?: number;
  writeTimeoutMs?: number;
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

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function metadataPath(path: string): boolean {
  return SAFE_METADATA_PATHS.has(path);
}

function categoryForRelayCode(code: string): RemoteErrorCategory {
  const normalized = code.toLowerCase();
  if (normalized.includes("auth") || normalized.includes("grant"))
    return "authentication_failure";
  if (normalized.includes("host") || normalized.includes("offline"))
    return "host_offline";
  if (normalized.includes("boundary") || normalized.includes("path"))
    return "boundary_rejected";
  return "upstream_timeout";
}

function isWriteAttempt(attempt: RequestAttempt): boolean {
  return attempt.method !== "GET" && attempt.method !== "HEAD";
}

function dispatchAttempt(
  attempt: RequestAttempt,
  phase:
    | "preparing"
    | "channel_ready"
    | "sent"
    | "response"
    | "failed"
    | "cancelled",
  category?: RemoteErrorCategory,
): void {
  dispatchRemoteRequestEvent({
    requestId: attempt.requestId,
    hostId: attempt.hostId,
    operation: attempt.operation,
    phase,
    category,
    sent: attempt.sent,
  });
}

function cloneSnapshot(snapshot: ResponseSnapshot): Response {
  return new Response(snapshot.body.slice(), {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: new Headers(snapshot.headers),
  });
}

function projectV2AgentList(
  request: Request,
  snapshot: ResponseSnapshot,
): ResponseSnapshot {
  if (
    request.method !== "GET" ||
    new URL(request.url).pathname !== "/api/agent" ||
    snapshot.status < 200 ||
    snapshot.status >= 300
  )
    return snapshot;

  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(snapshot.body));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return snapshot;
    const record = value as { location?: unknown; data?: unknown };
    if (
      !record.location ||
      typeof record.location !== "object" ||
      !Array.isArray(record.data)
    )
      return snapshot;

    // OpenCode 1.18.25's V2 agent endpoint returns a location envelope, while
    // the unchanged official bootstrap passes the response data directly to
    // normalizeAgentList. Project only this read response at the wrapper
    // boundary so the upstream source remains untouched and V1 responses are
    // left unchanged.
    const headers = snapshot.headers.filter(
      ([name]) => name.toLowerCase() !== "content-length",
    );
    return {
      ...snapshot,
      headers,
      body: encoder.encode(JSON.stringify(record.data)),
    };
  } catch {
    return snapshot;
  }
}

async function snapshotResponse(
  response: Response,
  timeoutMs: number,
  onTimeout: () => void,
  timeoutError: RemoteFetchError,
): Promise<ResponseSnapshot> {
  const read = response.arrayBuffer();
  if (timeoutMs <= 0) {
    const body = new Uint8Array(await read);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body,
    };
  }
  return await new Promise<ResponseSnapshot>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(timeoutError);
    }, timeoutMs);
    read.then(
      (buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body: new Uint8Array(buffer),
        });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function cacheKey(request: Request): string {
  const headers = filteredHeaders(request.headers);
  return `${request.method} ${request.url} ${JSON.stringify(headers)}`;
}

export function virtualOrigin(hostId: string): string {
  if (hostId.length < 8 || hostId.length > 128)
    throw new TypeError("invalid host id");
  return `https://h-${base32lower(sha256(encoder.encode(hostId)))}${VIRTUAL_SUFFIX}`;
}

export function createRemoteFetch(
  relay: BrowserRelay,
  hostIds: string[],
  options: RemoteFetchOptions = {},
): RemoteFetch {
  const hosts = new Map(
    hostIds.map((hostId) => [new URL(virtualOrigin(hostId)).hostname, hostId]),
  );
  const pending = new Map<string, PendingResponse>();
  const shared = new Map<string, SharedRequest>();
  const cache = new Map<
    string,
    { expiresAt: number; response: ResponseSnapshot }
  >();
  const listening = new WeakSet<RelayChannel>();
  const metrics: RemoteFetchMetrics = {
    requests: 0,
    completed: 0,
    failed: 0,
    cacheHits: 0,
    deduplicated: 0,
    timeouts: 0,
    aborted: 0,
    channelTimeouts: 0,
    upstreamTimeouts: 0,
    unknownWrites: 0,
  };
  let disposed = false;
  const metadataTimeoutMs = options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS;

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

  const rejectPending = (item: PendingResponse, error: RemoteFetchError) => {
    if (item.started) item.controller?.error(error);
    else item.reject(error);
    item.cleanup();
    dispatchAttempt(item.attempt, "failed", error.category);
  };

  const onPayload = (payload: RelayPayload) => {
    if (payload.type === "relay.disconnected") {
      for (const [requestId, item] of pending) {
        const category: RemoteErrorCategory = item.attempt.sent
          ? isWriteAttempt(item.attempt)
            ? "unknown_write_state"
            : "host_offline"
          : "channel_acquire_timeout";
        const error = new RemoteFetchError("relay disconnected", {
          category,
          requestId,
          hostId: item.attempt.hostId,
          sent: item.attempt.sent,
          retryable: !item.attempt.sent && category !== "host_offline",
        });
        rejectPending(item, error);
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
      dispatchAttempt(item.attempt, "response");
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
        const category = categoryForRelayCode(errorCode);
        const error = new RemoteFetchError(
          `relay request failed: ${errorCode}`,
          {
            category,
            requestId,
            hostId: item.attempt.hostId,
            sent: item.attempt.sent,
            retryable: category === "host_offline",
          },
        );
        console.error(`[AIALRA relay] request failed: ${errorCode}`);
        rejectPending(item, error);
      } else if (item.started) item.controller?.close();
      else {
        const error = new RemoteFetchError(
          "relay response ended before headers",
          {
            category:
              item.attempt.sent && isWriteAttempt(item.attempt)
                ? "unknown_write_state"
                : "upstream_timeout",
            requestId,
            hostId: item.attempt.hostId,
            sent: item.attempt.sent,
            retryable: !item.attempt.sent,
          },
        );
        rejectPending(item, error);
      }
      pending.delete(requestId);
      item.cleanup();
    }
  };

  const sendRequest = async (
    request: Request,
    hostId: string,
    signal: AbortSignal,
    attempt: RequestAttempt,
  ): Promise<Response> => {
    if (disposed) throw new Error("remote fetch is disposed");
    if (signal.aborted) throw abortError();
    const url = new URL(request.url);
    const event = url.pathname === "/event" || url.pathname.endsWith("/event");
    const channel = await channelFor(hostId, event);
    attempt.channelReady = true;
    dispatchAttempt(attempt, "channel_ready");
    if (signal.aborted) throw abortError();
    const requestId = attempt.requestId;
    const cancel = () => {
      const item = pending.get(requestId);
      if (!item) return;
      pending.delete(requestId);
      item.controller?.error(abortError());
      item.reject(abortError());
      dispatchAttempt(item.attempt, "cancelled", "cancelled");
      void channel
        .send({ type: "relay.http.cancel", requestId })
        .catch(() => {});
    };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const response = new Promise<Response>((resolve, reject) => {
      pending.set(requestId, {
        resolve,
        reject,
        controller: null,
        nextSequence: 0,
        started: false,
        cancel,
        cleanup,
        attempt,
      });
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? null
          : new Uint8Array(await request.clone().arrayBuffer());
      await channel.send({
        type: "relay.http.request",
        requestId,
        method: request.method,
        path: url.pathname,
        query: url.search.slice(1),
        headers: filteredHeaders(request.headers),
        bodyBase64: body ? base64url(body) : null,
      });
      attempt.sent = true;
      dispatchAttempt(attempt, "sent");
      return await response;
    } catch (error) {
      pending.delete(requestId);
      cleanup();
      if (error instanceof RemoteFetchError) throw error;
      if (signal.aborted) throw abortError();
      const category: RemoteErrorCategory = attempt.sent
        ? isWriteAttempt(attempt)
          ? "unknown_write_state"
          : "upstream_timeout"
        : attempt.channelReady
          ? "upstream_timeout"
          : "channel_acquire_timeout";
      const wrapped = new RemoteFetchError(
        error instanceof Error ? error.message : "remote request failed",
        {
          category,
          requestId,
          hostId,
          sent: attempt.sent,
          retryable: !attempt.sent,
          cause: error,
        },
      );
      dispatchAttempt(attempt, "failed", wrapped.category);
      throw wrapped;
    }
  };

  const timeoutFor = (request: Request): number => {
    const path = new URL(request.url).pathname;
    if (path === "/event" || path.endsWith("/event")) return 0;
    return metadataPath(path) ? metadataTimeoutMs : writeTimeoutMs;
  };

  const requestWithTimeout = async (
    request: Request,
    hostId: string,
    signal: AbortSignal,
    attempt: RequestAttempt,
  ): Promise<Response> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = timeoutFor(request);
    let timedOut = false;
    dispatchAttempt(attempt, "preparing");
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) {
      timer = setTimeout(() => {
        metrics.timeouts += 1;
        timedOut = true;
        controller.abort();
      }, timeout);
    }
    try {
      return await sendRequest(request, hostId, controller.signal, attempt);
    } catch (error) {
      if (timedOut && !signal.aborted && timer) {
        const category: RemoteErrorCategory =
          attempt.sent && isWriteAttempt(attempt)
            ? "unknown_write_state"
            : attempt.channelReady
              ? "upstream_timeout"
              : "channel_acquire_timeout";
        if (category === "channel_acquire_timeout")
          metrics.channelTimeouts += 1;
        if (category === "upstream_timeout") metrics.upstreamTimeouts += 1;
        if (category === "unknown_write_state") metrics.unknownWrites += 1;
        const wrapped = new RemoteFetchError("remote request timed out", {
          category,
          requestId: attempt.requestId,
          hostId,
          sent: attempt.sent,
          retryable: !attempt.sent && category !== "upstream_timeout",
          cause: error,
        });
        dispatchAttempt(attempt, "failed", category);
        throw wrapped;
      }
      if (signal.aborted) dispatchAttempt(attempt, "cancelled", "cancelled");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };

  const consumeShared = (
    entry: SharedRequest,
    signal: AbortSignal,
  ): Promise<Response> => {
    const token = Symbol("remote-fetch-consumer");
    entry.consumers.add(token);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        metrics.aborted += 1;
        finish();
        reject(abortError());
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        entry.consumers.delete(token);
        signal.removeEventListener("abort", onAbort);
        if (!entry.settled && entry.consumers.size === 0)
          entry.controller.abort();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (snapshot) => {
          if (settled) return;
          finish();
          resolve(cloneSnapshot(snapshot));
        },
        (error: unknown) => {
          if (settled) return;
          finish();
          reject(error);
        },
      );
    });
  };

  const fetchImpl = (async (
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
        : new Uint8Array(await request.clone().arrayBuffer());
    if (body && body.byteLength > MAX_REQUEST_BYTES)
      throw new TypeError("request body exceeds the relay limit");

    metrics.requests += 1;
    const attempt: RequestAttempt = {
      requestId: crypto.randomUUID(),
      hostId,
      method: request.method,
      operation: operationFor(url.pathname, request.method),
      channelReady: false,
      sent: false,
    };
    const canShare =
      (request.method === "GET" || request.method === "HEAD") &&
      metadataPath(url.pathname);
    if (!canShare) {
      try {
        const response = await requestWithTimeout(
          request,
          hostId,
          request.signal,
          attempt,
        );
        metrics.completed += 1;
        return response;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          metrics.failed += 1;
        throw error;
      }
    }

    const key = cacheKey(request);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      metrics.cacheHits += 1;
      return cloneSnapshot(cached.response);
    }
    if (cached) cache.delete(key);

    let entry = shared.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = requestWithTimeout(
        request,
        hostId,
        controller.signal,
        attempt,
      )
        .then(async (response) => {
          const bodyTimeoutError = new RemoteFetchError(
            "remote response body timed out",
            {
              category: "upstream_timeout",
              requestId: attempt.requestId,
              hostId,
              sent: attempt.sent,
              retryable: false,
            },
          );
          const snapshot = projectV2AgentList(
            request,
            await snapshotResponse(
              response,
              metadataTimeoutMs,
              () => {
                metrics.timeouts += 1;
                metrics.upstreamTimeouts += 1;
                controller.abort();
              },
              bodyTimeoutError,
            ),
          );
          if (
            snapshot.body.byteLength <= MAX_METADATA_CACHE_BYTES &&
            response.ok
          )
            cache.set(key, {
              expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
              response: snapshot,
            });
          metrics.completed += 1;
          return snapshot;
        })
        .catch((error) => {
          if (!(error instanceof DOMException && error.name === "AbortError"))
            metrics.failed += 1;
          throw error;
        })
        .finally(() => {
          entry!.settled = true;
          if (shared.get(key) === entry) shared.delete(key);
        });
      entry = { controller, promise, consumers: new Set(), settled: false };
      shared.set(key, entry);
    } else {
      metrics.deduplicated += 1;
    }
    return consumeShared(entry, request.signal);
  }) as RemoteFetch;

  fetchImpl.prewarm = async (requested = hostIds): Promise<void> => {
    const unique = [...new Set(requested)].filter((hostId) =>
      hosts.has(new URL(virtualOrigin(hostId)).hostname),
    );
    await Promise.allSettled(
      unique.flatMap((hostId) => [
        channelFor(hostId, false),
        channelFor(hostId, true),
      ]),
    );
  };
  fetchImpl.readMetrics = () => ({ ...metrics });
  fetchImpl.dispose = () => {
    disposed = true;
    for (const entry of shared.values()) entry.controller.abort();
    shared.clear();
    cache.clear();
    for (const [requestId, item] of pending) {
      rejectPending(
        item,
        new RemoteFetchError("remote fetch is disposed", {
          category: "cancelled",
          requestId,
          hostId: item.attempt.hostId,
          sent: item.attempt.sent,
        }),
      );
    }
    pending.clear();
  };
  return fetchImpl;
}
