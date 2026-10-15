import { AppError } from '../errors.js';

/**
 * Per-IP budget for failed authentication (invalid API keys, missing/expired dashboard sessions).
 * Rate limits are keyed by credential, so without this a client rotating made-up keys would get a
 * fresh bucket — and a database lookup — on every request. Checked before any lookup.
 */
export class AuthFailureLimiter {
  private readonly windows = new Map<string, { start: number; failures: number }>();

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws RATE_LIMITED if this IP has used up its failed-authentication budget. */
  assertAllowed(ip: string): void {
    const w = this.current(ip);
    if (w && w.failures >= this.maxPerMinute) {
      throw new AppError('RATE_LIMITED', 'Too many failed authentication attempts — try again in a minute');
    }
  }

  recordFailure(ip: string): void {
    const t = this.now();
    const w = this.current(ip);
    if (w) w.failures++;
    else this.windows.set(ip, { start: t, failures: 1 });
    if (this.windows.size > 50_000) this.prune(t);
  }

  private current(ip: string) {
    const w = this.windows.get(ip);
    if (!w) return undefined;
    if (this.now() - w.start >= 60_000) {
      this.windows.delete(ip);
      return undefined;
    }
    return w;
  }

  private prune(t: number): void {
    for (const [ip, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(ip);
  }
}
