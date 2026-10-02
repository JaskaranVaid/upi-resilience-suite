import type { Clock } from '../clock.js';
import type { PspResult } from '../psp/types.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface HealthOptions {
  windowSize?: number;
  minSamples?: number;
  /** Technical-decline rate at which the circuit opens. */
  openThreshold?: number;
  cooldownMs?: number;
  /** An outcome's weight in the score halves every this many ms, so old failures fade. */
  halfLifeMs?: number;
  /**
   * A non-blocked PSP idle for at least this long, and passed over for at least
   * `probeAfterPasses` payments, gets the next eligible payment first (a probe).
   * Caps probes at ~1/interval under heavy traffic and ~1 in (passes + 1) under light traffic.
   */
  probeIntervalMs?: number;
  probeAfterPasses?: number;
}

interface PspHealth {
  outcomes: Array<{ ok: boolean; at: number }>;
  openedAt: number | null;
  /** Last time the PSP handled (or was reserved for) any payment attempt. */
  lastSeenAt: number | null;
  /** Payments routed with this PSP not first, since it last handled one. */
  passedOver: number;
}

export interface HealthSnapshot {
  pspId: string;
  state: CircuitState;
  score: number;
  samples: number;
}

/**
 * Per-PSP health from recent technical outcomes, with a circuit breaker. Business declines
 * are ignored: a customer's insufficient balance says nothing about PSP health.
 *
 * Scores are time-decayed and idle PSPs are probed, so a provider that had a bad patch is
 * never starved of the traffic it needs to show it has recovered.
 *
 * In-process state — each API/worker instance learns independently, which is fine at MVP
 * scale; move to Redis if instances must share it.
 */
export class HealthTracker {
  private readonly psps = new Map<string, PspHealth>();
  private readonly opts: Required<HealthOptions>;
  private readonly startedAt: number;

  constructor(opts: HealthOptions, private readonly clock: Clock) {
    this.opts = {
      windowSize: 50,
      minSamples: 10,
      openThreshold: 0.5,
      cooldownMs: 30_000,
      halfLifeMs: 10 * 60_000,
      probeIntervalMs: 60_000,
      probeAfterPasses: 10,
      ...opts,
    };
    this.startedAt = clock.now().getTime();
  }

  record(pspId: string, result: PspResult): void {
    const h = this.get(pspId);
    const now = this.clock.now().getTime();
    h.lastSeenAt = now; // any response is traffic, even a customer decline
    h.passedOver = 0;

    let ok: boolean;
    if (result.kind === 'SUCCESS') ok = true;
    else if (result.kind === 'TECHNICAL_DECLINE') ok = false;
    else return;

    const state = this.state(pspId);
    if (state === 'HALF_OPEN') {
      if (ok) {
        h.outcomes = [{ ok: true, at: now }];
        h.openedAt = null;
      } else {
        h.openedAt = now;
      }
      return;
    }

    h.outcomes.push({ ok, at: now });
    if (h.outcomes.length > this.opts.windowSize) h.outcomes.shift();
    if (state === 'CLOSED' && h.outcomes.length >= this.opts.minSamples) {
      const failRate = h.outcomes.filter((o) => !o.ok).length / h.outcomes.length;
      if (failRate >= this.opts.openThreshold) h.openedAt = now;
    }
  }

  state(pspId: string): CircuitState {
    const h = this.get(pspId);
    if (h.openedAt === null) return 'CLOSED';
    return this.clock.now().getTime() - h.openedAt >= this.opts.cooldownMs ? 'HALF_OPEN' : 'OPEN';
  }

  /**
   * Time-weighted success rate: recent outcomes dominate (half-life `halfLifeMs`), and as they
   * age the score falls back to the PSP's longer-run record (its last `windowSize` outcomes)
   * rather than to "unknown" — so sparse traffic doesn't erase what we know, while fresh
   * evidence (e.g. a successful probe) still moves the score quickly.
   */
  score(pspId: string): number {
    const now = this.clock.now().getTime();
    const outcomes = this.get(pspId).outcomes;
    const longRun = (outcomes.filter((o) => o.ok).length + 1) / (outcomes.length + 2); // Laplace
    const PRIOR_WEIGHT = 2;
    let successes = PRIOR_WEIGHT * longRun;
    let total = PRIOR_WEIGHT;
    for (const o of outcomes) {
      const w = 0.5 ** ((now - o.at) / this.opts.halfLifeMs);
      total += w;
      if (o.ok) successes += w;
    }
    return successes / total;
  }

  /** Order candidates: open circuits last, then by score, then by given priority. Pure. */
  rank(pspIds: string[]): string[] {
    return pspIds
      .map((id, i) => ({ id, i, open: this.state(id) === 'OPEN' ? 1 : 0, score: this.score(id) }))
      .sort((a, b) => a.open - b.open || b.score - a.score || a.i - b.i)
      .map((x) => x.id);
  }

  /**
   * The order to try PSPs for one payment: `rank`, except that a non-blocked PSP that has been
   * idle and passed over long enough goes first (a probe). At most one probe per payment; the
   * probed PSP is reserved so probes stay rare. A failed probe falls back like any failure.
   */
  route(pspIds: string[]): string[] {
    return this.routeWithProbe(pspIds).order;
  }

  /** As `route`, also naming the PSP being probed (its attempts must not earn recovery credit). */
  routeWithProbe(pspIds: string[]): { order: string[]; probe: string | null } {
    const ranked = this.rank(pspIds);
    const now = this.clock.now().getTime();
    const due = (id: string) => {
      const h = this.get(id);
      return (
        this.state(id) !== 'OPEN' &&
        h.passedOver >= this.opts.probeAfterPasses &&
        now - (h.lastSeenAt ?? this.startedAt) >= this.opts.probeIntervalMs
      );
    };
    const probe = ranked.slice(1).find(due);
    const order = probe ? [probe, ...ranked.filter((id) => id !== probe)] : ranked;
    order.slice(1).forEach((id) => this.get(id).passedOver++);
    if (probe) {
      const h = this.get(probe);
      h.lastSeenAt = now;
      h.passedOver = 0;
    }
    return { order, probe: probe ?? null };
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
      h = { outcomes: [], openedAt: null, lastSeenAt: null, passedOver: 0 };
      this.psps.set(pspId, h);
    }
    return h;
  }
}
