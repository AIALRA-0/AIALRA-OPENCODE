import { describe, expect, it } from "vitest";
import { relayRouteFingerprint, relayRouteShape } from "../src/agent.js";

describe("relayRouteFingerprint", () => {
  it("is stable without revealing the route", () => {
    expect(relayRouteFingerprint("get", "/session/example")).toBe(
      relayRouteFingerprint("GET", "/session/example"),
    );
    expect(relayRouteFingerprint("GET", "/session/example")).toMatch(
      /^[a-f0-9]{16}$/,
    );
    expect(relayRouteFingerprint("GET", "/session/example")).not.toContain(
      "session",
    );
  });

  it("reports only an allowlisted namespace and structural shape", () => {
    expect(relayRouteShape("/session/private-value/message")).toBe(
      "session:3:plain",
    );
    expect(relayRouteShape("/api/session/private-value")).toBe(
      "api/session:3:plain",
    );
    expect(relayRouteShape("/api/private-value")).toBe("api/unknown:2:plain");
    expect(relayRouteShape("/private/value/")).toBe("unknown:2:slash");
  });
});
