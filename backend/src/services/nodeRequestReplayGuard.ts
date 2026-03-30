export class NodeRequestReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  consume(nonce: string, timestampMs: number): boolean {
    this.prune(timestampMs);
    if (this.seen.has(nonce)) {
      return false;
    }
    this.seen.set(nonce, timestampMs + this.ttlMs);
    if (this.seen.size > this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (typeof oldestKey === "string") {
        this.seen.delete(oldestKey);
      }
    }
    return true;
  }

  private prune(nowMs: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) {
        this.seen.delete(nonce);
      }
    }
  }
}
