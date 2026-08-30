import { describe, expect, it } from "vitest";
import { HeartbeatWatchdog } from "../src/heartbeat.js";

describe("HeartbeatWatchdog", () => {
  it("expires a half-open control connection after the silence limit", () => {
    let now = 1_000;
    const watchdog = new HeartbeatWatchdog(25_000, () => now);

    now += 25_000;
    expect(watchdog.expired()).toBe(false);
    now += 1;
    expect(watchdog.expired()).toBe(true);
  });

  it("extends the connection lifetime after a server acknowledgement", () => {
    let now = 1_000;
    const watchdog = new HeartbeatWatchdog(25_000, () => now);

    now += 20_000;
    watchdog.acknowledge();
    now += 20_000;
    expect(watchdog.expired()).toBe(false);
  });
});
