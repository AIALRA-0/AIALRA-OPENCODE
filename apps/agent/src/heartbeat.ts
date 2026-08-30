export class HeartbeatWatchdog {
  private acknowledgedAt: number;

  constructor(
    private readonly maxSilenceMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(maxSilenceMs) || maxSilenceMs <= 0)
      throw new Error("heartbeat silence limit must be positive");
    this.acknowledgedAt = this.now();
  }

  acknowledge(): void {
    this.acknowledgedAt = this.now();
  }

  expired(): boolean {
    return this.now() - this.acknowledgedAt > this.maxSilenceMs;
  }
}
