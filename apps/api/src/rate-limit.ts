import { ApiError } from "./errors.js";

/**
 * Fixed-window counters held in memory. Enough for one API instance; with several
 * instances each enforces its own limit (or put a shared limiter in front).
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit for `key`; throws 429 RATE_LIMITED once `max` is exceeded in `windowMs`. */
  hit(key: string, max: number, windowMs: number): void {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 50_000) this.sweep(t, windowMs);
      return;
    }
    w.count += 1;
    if (w.count > max) {
      throw new ApiError(429, "RATE_LIMITED", "too many requests; try again later", Math.ceil((w.start + windowMs - t) / 1000));
    }
  }

  private sweep(t: number, windowMs: number) {
    for (const [k, w] of this.windows) if (t - w.start >= windowMs) this.windows.delete(k);
  }
}

/** Limits per client IP (auth) and per account (verification), per 10-minute window. */
export interface Limits {
  authPerIp: { max: number; windowMs: number };
  verificationsPerAccount: { max: number; windowMs: number };
}

export const LIMITS: Limits = {
  authPerIp: { max: 30, windowMs: 10 * 60_000 },
  verificationsPerAccount: { max: 20, windowMs: 10 * 60_000 },
};
