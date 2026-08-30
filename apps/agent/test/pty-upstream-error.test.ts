import { describe, expect, it } from "vitest";
import { ptyUpstreamClose } from "../src/pty-upstream-error.js";

describe("PTY upstream failure mapping", () => {
  it("maps expired tickets and missing sessions without exposing details", () => {
    expect(
      ptyUpstreamClose(new Error("Unexpected server response: 403")),
    ).toEqual({ code: 4403, reason: "PTY authorization expired" });
    expect(
      ptyUpstreamClose(new Error("Unexpected server response: 404")),
    ).toEqual({ code: 4404, reason: "PTY session not found" });
  });

  it("uses an internal-error close for every other failure", () => {
    expect(ptyUpstreamClose(new Error("connect failed"))).toEqual({
      code: 1011,
      reason: "OpenCode PTY connection failed",
    });
  });

  it("marks a stalled loopback handshake for terminal replacement", () => {
    expect(
      ptyUpstreamClose(new Error("Opening handshake has timed out")),
    ).toEqual({
      code: 4410,
      reason: "OpenCode PTY handshake timed out",
    });
  });
});
