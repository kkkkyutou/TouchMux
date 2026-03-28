interface AttemptState {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  getBlockRemainingMs(key: string): number {
    const now = Date.now();
    const state = this.attempts.get(key);
    if (!state || state.blockedUntil <= now) {
      return 0;
    }
    return state.blockedUntil - now;
  }

  registerSuccess(key: string): void {
    this.attempts.delete(key);
  }

  registerFailure(key: string): number {
    const now = Date.now();
    const current = this.attempts.get(key);
    const next =
      !current || now - current.firstFailureAt > this.windowMs
        ? { failures: 1, firstFailureAt: now, blockedUntil: 0 }
        : {
            failures: current.failures + 1,
            firstFailureAt: current.firstFailureAt,
            blockedUntil: current.blockedUntil,
          };

    if (next.failures >= this.maxAttempts) {
      next.blockedUntil = now + this.windowMs;
      next.failures = 0;
      next.firstFailureAt = now;
    }

    this.attempts.set(key, next);
    return Math.max(0, next.blockedUntil - now);
  }
}
