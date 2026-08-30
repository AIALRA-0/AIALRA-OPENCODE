import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  consumeRate,
  parseCookies,
  sendRelayMessage,
  sendRelayMessageAndClose,
} from "../src/relay.js";

describe("relay input hardening", () => {
  it("ignores malformed cookie encoding without throwing", () => {
    expect(parseCookies("valid=one; broken=%E0%A4%A; another=two")).toEqual({
      valid: "one",
      another: "two",
    });
  });

  it("enforces a bounded rate window and resets at the boundary", () => {
    const window = { startedAt: 1_000, count: 0 };
    expect(consumeRate(window, 2, 10_000, 1_001)).toBe(true);
    expect(consumeRate(window, 2, 10_000, 1_002)).toBe(true);
    expect(consumeRate(window, 2, 10_000, 1_003)).toBe(false);
    expect(consumeRate(window, 2, 10_000, 11_000)).toBe(true);
    expect(window).toEqual({ startedAt: 11_000, count: 1 });
  });

  it("serializes burst responses instead of closing after the former 4 MiB threshold", () => {
    const sent: string[] = [];
    const callbacks: Array<(error?: Error) => void> = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(data: string, callback: (error?: Error) => void) {
        sent.push(data);
        callbacks.push(callback);
      },
      close(code: number, reason: string) {
        closed.push({ code, reason });
      },
    };
    const body = "x".repeat(600 * 1024);
    for (let index = 0; index < 10; index += 1)
      sendRelayMessage(socket, { index, body });

    expect(sent).toHaveLength(1);
    while (callbacks.length) callbacks.shift()?.();
    expect(sent).toHaveLength(10);
    expect(sent.map((value) => JSON.parse(value).index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(closed).toEqual([]);
  });

  it("waits for the enrollment response to flush before closing", () => {
    let flushed: ((error?: Error) => void) | undefined;
    const closed: Array<{ code: number; reason: string }> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(_data: string, callback: (error?: Error) => void) {
        flushed = callback;
      },
      close(code: number, reason: string) {
        closed.push({ code, reason });
      },
    };

    sendRelayMessageAndClose(
      socket,
      { type: "server.enrolled" },
      1000,
      "enrollment complete",
    );

    expect(closed).toEqual([]);
    flushed?.();
    expect(closed).toEqual([{ code: 1000, reason: "enrollment complete" }]);
  });
});
