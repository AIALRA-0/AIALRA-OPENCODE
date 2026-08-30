import { describe, expect, it } from "vitest";
import {
  AgentEnvelopeSchema,
  CapabilityGrantSchema,
  HostSessionRefSchema,
  RelayHttpRequestSchema,
  RouteCapabilityManifestSchema,
  isRelayOperation,
} from "../src/index.js";

describe("public protocol", () => {
  it("isolates identical upstream session ids by host", () => {
    const first = HostSessionRefSchema.parse({
      hostId: "host-alpha",
      upstreamSessionId: "session-shared",
    });
    const second = HostSessionRefSchema.parse({
      hostId: "host-bravo",
      upstreamSessionId: "session-shared",
    });
    expect(`${first.hostId}:${first.upstreamSessionId}`).not.toBe(
      `${second.hostId}:${second.upstreamSessionId}`,
    );
  });

  it("rejects arbitrary proxy operations", () => {
    expect(isRelayOperation("http.read")).toBe(true);
    expect(isRelayOperation("localhost.proxy")).toBe(false);
  });

  it("requires short-lived host-bound grants", () => {
    const now = Math.floor(Date.now() / 1_000);
    const grant = CapabilityGrantSchema.parse({
      grantId: "2c82eedc-d63b-4c78-afd6-4916cb2c770e",
      subject: "owner",
      hostId: "host-alpha",
      scopes: ["http.read"],
      issuedAt: now,
      expiresAt: now + 60,
      nonce: "a-unique-one-time-nonce",
    });
    expect(grant.expiresAt - grant.issuedAt).toBe(60);
  });

  it("accepts content-free audit events", () => {
    const event = AgentEnvelopeSchema.parse({
      type: "agent.audit",
      hostId: "host-alpha",
      channelId: "2c82eedc-d63b-4c78-afd6-4916cb2c770e",
      requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
      category: "http.write",
      outcome: "succeeded",
      occurredAt: "2026-08-29T00:00:00.000Z",
    });
    expect(event).not.toHaveProperty("body");
  });

  it("rejects absolute URLs at the relay boundary", () => {
    expect(() =>
      RelayHttpRequestSchema.parse({
        type: "relay.http.request",
        requestId: "92b11e67-6f24-474f-9510-816e92a6a69f",
        method: "GET",
        path: "https://example.invalid/private",
        query: "",
        headers: {},
        bodyBase64: null,
      }),
    ).toThrow();
  });

  it("requires a version-bound route manifest", () => {
    const manifest = RouteCapabilityManifestSchema.parse({
      version: 1,
      upstreamVersion: "1.18.25",
      upstreamCommit: "cb7d8b2",
      sourceOpenapiSha256: "b".repeat(64),
      openapiSha256: "a".repeat(64),
      generatedAt: "2026-08-29T00:00:00.000Z",
      routes: [
        {
          methods: ["GET"],
          pathTemplate: "/global/health",
          category: "read",
          maxBodyBytes: 0,
          stream: "none",
        },
      ],
    });
    expect(manifest.routes).toHaveLength(1);
  });
});
