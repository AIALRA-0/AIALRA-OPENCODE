import { expect, test } from "bun:test";
import { base64url } from "../src/codec";
import {
  createRemoteFetch,
  virtualOrigin,
  type RemoteFetch,
} from "../src/remote-fetch";
import { RemoteFetchError } from "../src/action-state";

type Listener = (payload: Record<string, unknown> & { type: string }) => void;

class FakeChannel {
  readonly sends: Record<string, unknown>[] = [];
  private readonly listeners = new Set<Listener>();
  respond = true;
  headersOnly = false;
  responseBody = '{"directory":"/workspace"}';

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  expiresSoon(): boolean {
    return false;
  }

  close(): void {}

  async send(payload: Record<string, unknown>): Promise<void> {
    this.sends.push(payload);
    if (payload.type !== "relay.http.request" || !this.respond) return;
    const requestId = String(payload.requestId);
    queueMicrotask(() => {
      for (const listener of this.listeners)
        listener({
          type: "relay.http.response.start",
          requestId,
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (this.headersOnly) return;
      for (const listener of this.listeners)
        listener({
          type: "relay.http.chunk",
          requestId,
          sequence: 0,
          bodyBase64: base64url(new TextEncoder().encode(this.responseBody)),
        });
      for (const listener of this.listeners)
        listener({ type: "relay.http.end", requestId, errorCode: null });
    });
  }

  emit(payload: Record<string, unknown> & { type: string }): void {
    for (const listener of this.listeners) listener(payload);
  }
}

class FakeRelay {
  readonly channels = new Map<string, FakeChannel>();

  channel(hostId: string, kind: string): Promise<FakeChannel> {
    const key = `${hostId}:${kind}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = new FakeChannel();
      this.channels.set(key, channel);
    }
    return Promise.resolve(channel);
  }
}

function requestUrl(hostId: string, path: string): string {
  return `${virtualOrigin(hostId)}${path}`;
}

test("deduplicates concurrent metadata reads and serves the short cache", async () => {
  const hostId = "host-test-1234";
  const relay = new FakeRelay();
  const remote = createRemoteFetch(relay as never, [hostId]);

  const [first, second] = await Promise.all([
    remote(requestUrl(hostId, "/path")),
    remote(requestUrl(hostId, "/path")),
  ]);
  expect(await first.json()).toEqual({ directory: "/workspace" });
  expect(await second.json()).toEqual({ directory: "/workspace" });
  const channel = relay.channels.get(`${hostId}:opencode-http`)!;
  expect(
    channel.sends.filter((item) => item.type === "relay.http.request"),
  ).toHaveLength(1);

  const cached = await remote(requestUrl(hostId, "/path"));
  expect(await cached.json()).toEqual({ directory: "/workspace" });
  expect(
    channel.sends.filter((item) => item.type === "relay.http.request"),
  ).toHaveLength(1);
  expect(remote.readMetrics()).toMatchObject({ deduplicated: 1, cacheHits: 1 });
  remote.dispose();
});

test("prewarms both HTTP and event channels without issuing content requests", async () => {
  const hostId = "host-test-5678";
  const relay = new FakeRelay();
  const remote = createRemoteFetch(relay as never, [hostId]);
  await remote.prewarm();
  expect(relay.channels.has(`${hostId}:opencode-http`)).toBe(true);
  expect(relay.channels.has(`${hostId}:opencode-event`)).toBe(true);
  expect(
    [...relay.channels.values()].every((channel) => channel.sends.length === 0),
  ).toBe(true);
  remote.dispose();
});

test("projects the V2 agent location envelope for the official bootstrap", async () => {
  const hostId = "host-test-agent-envelope";
  const relay = new FakeRelay();
  const channel = new FakeChannel();
  channel.responseBody = JSON.stringify({
    location: { directory: "/workspace" },
    data: [{ id: "build", mode: "primary" }],
  });
  relay.channels.set(`${hostId}:opencode-http`, channel);
  const remote = createRemoteFetch(relay as never, [hostId]);

  const response = await remote(requestUrl(hostId, "/api/agent"));
  expect(await response.json()).toEqual([{ id: "build", mode: "primary" }]);
  expect(
    channel.sends.filter((item) => item.type === "relay.http.request"),
  ).toHaveLength(1);
  remote.dispose();
});

test("cancels a shared metadata request only after every consumer aborts", async () => {
  const hostId = "host-test-9012";
  const relay = new FakeRelay();
  const channel = new FakeChannel();
  channel.respond = false;
  relay.channels.set(`${hostId}:opencode-http`, channel);
  const remote: RemoteFetch = createRemoteFetch(relay as never, [hostId]);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = remote(requestUrl(hostId, "/path"), {
    signal: firstController.signal,
  });
  const second = remote(requestUrl(hostId, "/path"), {
    signal: secondController.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  firstController.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(
    channel.sends.filter((item) => item.type === "relay.http.cancel"),
  ).toHaveLength(0);
  secondController.abort();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect(
    channel.sends.filter((item) => item.type === "relay.http.cancel"),
  ).toHaveLength(1);
  remote.dispose();
});

test("does not resend a write after the relay disconnects", async () => {
  const hostId = "host-test-write-1";
  const relay = new FakeRelay();
  const channel = new FakeChannel();
  channel.respond = false;
  relay.channels.set(`${hostId}:opencode-http`, channel);
  const remote = createRemoteFetch(relay as never, [hostId]);

  const request = remote(requestUrl(hostId, "/session/session-1/prompt"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "safe test" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  channel.emit({ type: "relay.disconnected" });

  await expect(request).rejects.toBeInstanceOf(RemoteFetchError);
  await expect(request).rejects.toMatchObject({
    category: "unknown_write_state",
    sent: true,
    retryable: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    channel.sends.filter((item) => item.type === "relay.http.request"),
  ).toHaveLength(1);
  expect(remote.readMetrics()).toMatchObject({ unknownWrites: 0, failed: 1 });
  remote.dispose();
});

test("dispose rejects a pending write as cancelled without retrying", async () => {
  const hostId = "host-test-write-2";
  const relay = new FakeRelay();
  const channel = new FakeChannel();
  channel.respond = false;
  relay.channels.set(`${hostId}:opencode-http`, channel);
  const remote = createRemoteFetch(relay as never, [hostId]);
  const request = remote(requestUrl(hostId, "/api/project"), {
    method: "PATCH",
    body: JSON.stringify({ name: "safe test" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  remote.dispose();
  await expect(request).rejects.toMatchObject({
    category: "cancelled",
    sent: true,
  });
  expect(
    channel.sends.filter((item) => item.type === "relay.http.request"),
  ).toHaveLength(1);
});

test("times out a metadata response whose body never completes", async () => {
  const hostId = "host-test-body-timeout";
  const relay = new FakeRelay();
  const channel = new FakeChannel();
  channel.headersOnly = true;
  relay.channels.set(`${hostId}:opencode-http`, channel);
  const remote = createRemoteFetch(relay as never, [hostId], {
    metadataTimeoutMs: 25,
  });

  await expect(remote(requestUrl(hostId, "/path"))).rejects.toMatchObject({
    category: "upstream_timeout",
    retryable: false,
  });
  expect(remote.readMetrics()).toMatchObject({
    timeouts: 1,
    upstreamTimeouts: 1,
    failed: 1,
  });
  expect(
    channel.sends.filter((item) => item.type === "relay.http.request"),
  ).toHaveLength(1);
  remote.dispose();
});
