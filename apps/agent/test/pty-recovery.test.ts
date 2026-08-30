import { describe, expect, it } from "vitest";
import {
  stalePtyIdFromResource,
  stalePtyIdFromSocket,
} from "../src/pty-recovery.js";

describe("stale PTY recovery", () => {
  it("derives the official terminal id from v1 and v2 paths", () => {
    const first = "pty_0123456789ABCDEFGHIJKLMNOP";
    const second = "pty_abcdefghijklmnopqrstuvwxYZ";
    expect(stalePtyIdFromSocket(`/pty/${first}/connect`)).toBe(first);
    expect(stalePtyIdFromSocket(`/api/pty/${second}/connect`)).toBe(second);
    expect(stalePtyIdFromResource(`/pty/${first}`)).toBe(first);
    expect(stalePtyIdFromResource(`/api/pty/${second}`)).toBe(second);
  });

  it("rejects unrelated or nested paths", () => {
    expect(stalePtyIdFromSocket("/pty/arbitrary")).toBeNull();
    expect(stalePtyIdFromSocket("/pty/../connect")).toBeNull();
    expect(stalePtyIdFromSocket("/pty/pty_%2e%2e/connect")).toBeNull();
    expect(stalePtyIdFromSocket("/api/pty/a/connect/extra")).toBeNull();
    expect(stalePtyIdFromResource("/pty/../ignored")).toBeNull();
  });
});
