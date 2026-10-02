import type { Clock } from '../clock.js';
import type { PspResult } from '../psp/types.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface HealthOptions {
  windowSize?: number;
  minSamples?: number;
  /** Technical-decline rate at which the circuit opens. */
  openThreshold?: number;
  cooldownMs?: number;
}

interface PspHealth {
  outcomes: boolean[];
  openedAt: number | null;
}

export interface HealthSnapshot {
  pspId: string;
  state: CircuitState;
  score: number;
  samples: number;
}

/**
 * Per-PSP sliding window of technical outcomes with a circuit breaker. Business declines
 * are ignored: a customer's insufficient balance says nothing about PSP health.
 * In-process state — each API/worker instance learns independently, which is fine at MVP
 * scale; move to Redis if instances must share it.
 */
export class HealthTracker {
  private readonly psps = new Map<string, PspHealth>();
  private readonly opts: Required<HealthOptions>;

  constructor(opts: HealthOptions, private readonly clock: Clock) {
    this.opts = { windowSize: 50, minSamples: 10, openThreshold: 0.5, cooldownMs: 30_000, ...opts };
  }

  record(pspId: string, result: PspResult): void {
    let ok: boolean;
    if (result.kind === 'SUCCESS') ok = true;
    else if (result.kind === 'TECHNICAL_DECLINE') ok = false;
    else return;

    const h = this.get(pspId);
    const state = this.state(pspId);
    if (state === 'HALF_OPEN') {
      if (ok) {
        h.outcomes = [true];
        h.openedAt = null;
      } else {
        h.openedAt = this.clock.now().getTime();
      }
      return;
    }

    h.outcomes.push(ok);
    if (h.outcomes.length > this.opts.windowSize) h.outcomes.shift();
    if (state === 'CLOSED' && h.outcomes.length >= this.opts.minSamples) {
      const failRate = h.outcomes.filter((o) => !o).length / h.outcomes.length;
      if (failRate >= this.opts.openThreshold) h.openedAt = this.clock.now().getTime();
    }
  }

  state(pspId: string): CircuitState {
    const h = this.get(pspId);
    if (h.openedAt === null) return 'CLOSED';
    return this.clock.now().getTime() - h.openedAt >= this.opts.cooldownMs ? 'HALF_OPEN' : 'OPEN';
  }

  /** Laplace-smoothed success rate, so a PSP with no data scores 0.5…1 rather than 0. */
  score(pspId: string): number {
    const o = this.get(pspId).outcomes;
    return (o.filter(Boolean).length + 1) / (o.length + 2);
  }

  /** Order candidates: open circuits last, then by score, then by given priority. */
  rank(pspIds: string[]): string[] {
    return pspIds
      .map((id, i) => ({ id, i, open: this.state(id) === 'OPEN' ? 1 : 0, score: this.score(id) }))
      .sort((a, b) => a.open - b.open || b.score - a.score || a.i - b.i)
      .map((x) => x.id);
  }

  snapshot(): HealthSnapshot[] {
    return [...this.psps.keys()].map((pspId) => ({
      pspId,
      state: this.state(pspId),
      score: Number(this.score(pspId).toFixed(4)),
      samples: this.get(pspId).outcomes.length,
    }));
  }

  private get(pspId: string): PspHealth {
    let h = this.psps.get(pspId);
    if (!h) {
      h = { outcomes: [], openedAt: null };
      this.psps.set(pspId, h);
    }
    return h;
  }
}
