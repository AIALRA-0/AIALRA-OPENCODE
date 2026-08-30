import { describe, expect, test } from "bun:test";
import { nextRelayRetryState, relayRetryDelay } from "../src/relay-retry";

describe("relay setup retry", () => {
  test("backs off exponentially and caps at fifteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(relayRetryDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ]);
  });

  test("records the next retry deadline from the current clock", () => {
    const first = nextRelayRetryState(undefined, 10_000);
    expect(first).toEqual({ attempts: 1, retryAt: 10_500 });
    expect(nextRelayRetryState(first, 11_000)).toEqual({
      attempts: 2,
      retryAt: 12_000,
    });
  });
});
