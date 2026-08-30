import { describe, expect, it } from "vitest";
import { safeReturnPath } from "../src/auth.js";

describe("identity redirects", () => {
  const origin = new URL("https://kimi.example.invalid");

  it("keeps same-origin paths", () => {
    expect(safeReturnPath("/session?elevated=1#terminal", origin)).toBe(
      "/session?elevated=1#terminal",
    );
  });

  it.each([
    "https://attacker.invalid",
    "//attacker.invalid",
    "/\\attacker.invalid",
    "/safe\r\nLocation: https://attacker.invalid",
  ])("rejects external or ambiguous return target %s", (target) => {
    expect(safeReturnPath(target, origin)).toBe("/");
  });
});
