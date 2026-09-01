import { describe, expect, it } from "vitest";
import type { RouteCapabilityManifest } from "@aialra-opencode/protocol";
import { RoutePolicy } from "../src/route-policy.js";

const manifest: RouteCapabilityManifest = {
  version: 1,
  upstreamVersion: "1.18.25",
  upstreamCommit: "cb7d8b2",
  sourceOpenapiSha256: "b".repeat(64),
  openapiSha256: "a".repeat(64),
  generatedAt: "2026-08-29T00:00:00.000Z",
  routes: [
    {
      methods: ["GET"],
      pathTemplate: "/session/{sessionID}",
      category: "read",
      maxBodyBytes: 0,
      stream: "none",
    },
    {
      methods: ["POST"],
      pathTemplate: "/session",
      category: "write",
      maxBodyBytes: 1024,
      stream: "none",
    },
    {
      methods: ["GET"],
      pathTemplate: "/event",
      category: "event",
      maxBodyBytes: 0,
      stream: "sse",
    },
    {
      methods: ["GET"],
      pathTemplate: "/pty/{ptyID}/connect",
      category: "pty",
      maxBodyBytes: 0,
      stream: "websocket",
    },
    {
      methods: ["GET"],
      pathTemplate: "/api/model/default",
      category: "read",
      maxBodyBytes: 0,
      stream: "none",
    },
    {
      methods: ["GET"],
      pathTemplate: "/api/fs/read/*",
      category: "read",
      maxBodyBytes: 0,
      stream: "none",
    },
  ],
};

describe("route policy", () => {
  const policy = new RoutePolicy(manifest);

  it("accepts a declared templated route", () => {
    expect(
      policy.authorizeHttp({
        type: "relay.http.request",
        requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
        method: "GET",
        path: "/session/ses_123",
        query: "",
        headers: {},
        bodyBase64: null,
      }).category,
    ).toBe("read");
  });

  it.each([
    "//example.invalid/",
    "/../secret",
    "/%2e%2e/secret",
    "/session\\secret",
  ])("rejects unsafe path %s", (path) => {
    expect(() =>
      policy.authorizeHttp({
        type: "relay.http.request",
        requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
        method: "GET",
        path,
        query: "",
        headers: {},
        bodyBase64: null,
      }),
    ).toThrow();
  });

  it("rejects undeclared localhost proxy routes", () => {
    expect(() =>
      policy.authorizeHttp({
        type: "relay.http.request",
        requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
        method: "POST",
        path: "/proxy/http://127.0.0.1",
        query: "",
        headers: {},
        bodyBase64: null,
      }),
    ).toThrow();
  });

  it("allows only declared PTY websocket paths", () => {
    expect(policy.authorizeSocket("/pty/pty_123/connect").stream).toBe(
      "websocket",
    );
    expect(() => policy.authorizeSocket("/socket/arbitrary")).toThrow();
  });

  it("accepts pinned compatibility aliases and file path wildcards", () => {
    expect(
      policy.authorizeHttp({
        type: "relay.http.request",
        requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
        method: "GET",
        path: "/api/model/default",
        query: "",
        headers: {},
        bodyBase64: null,
      }).category,
    ).toBe("read");
    expect(
      policy.authorizeHttp({
        type: "relay.http.request",
        requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
        method: "GET",
        path: "/api/fs/read/src/lib/example.ts",
        query: "",
        headers: {},
        bodyBase64: null,
      }).category,
    ).toBe("read");
  });
});
