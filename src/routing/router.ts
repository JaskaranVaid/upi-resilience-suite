import type { Clock, Sleep } from '../clock.js';
import type { PspAdapter, PspResult } from '../psp/types.js';
import type { HealthTracker } from './health.js';

export interface RouterOptions {
  /** Wait before status-checking a timed-out attempt (uniform in [min, max]). */
  timeoutRetryDelayMs?: [number, number];
  /** Stop starting new attempts once this much time has elapsed. */
  maxTotalMs?: number;
  random?: () => number;
}

export interface RouteRequest {
  op: 'mandate' | 'collect';
  /** PSPs allowed to process this payment, in configured priority order. */
  candidates: string[];
  amountPaise: number;
  mandateRef?: string;
  payerVpa?: string;
  /** Stable prefix for txnRefs (e.g. the debit id) so attempts are traceable. */
  baseRef: string;
}

export interface AttemptRecord {
  pspId: string;
  txnRef: string;
  op: 'execute' | 'collect' | 'status';
  result: PspResult;
  latencyMs: number;
}

export interface RouteOutcome {
  /** SUCCESS, PENDING, BUSINESS_DECLINE, or the last TECHNICAL_DECLINE. */
  result: PspResult;
  pspId?: string;
  txnRef?: string;
  attempts: AttemptRecord[];
  hadTechnicalDecline: boolean;
}

const TIMEOUT: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' };

/**
 * Cascading PSP router.
 *  - Business declines are final: never retried, never failed over.
 *  - A timeout is ambiguous (the bank may have debited), so we wait, check status, and
 *    only retry — on the same PSP with the same txnRef — if the PSP has no record of it.
 *  - Other technical declines fail over to the next-healthiest PSP with a fresh txnRef.
 */
export class Router {
  private readonly adapters: Map<string, PspAdapter>;
  private readonly opts: Required<RouterOptions>;

  constructor(
    adapters: PspAdapter[],
    private readonly health: HealthTracker,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    opts: RouterOptions = {},
  ) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    this.opts = { timeoutRetryDelayMs: [3000, 5000], maxTotalMs: 30_000, random: Math.random, ...opts };
  }

  adapter(id: string): PspAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown PSP ${id}`);
    return a;
  }

  /** Status lookup used by reconciliation of PENDING payments. */
  async status(pspId: string, txnRef: string): Promise<PspResult> {
    return this.adapter(pspId).status(txnRef);
  }

  async execute(req: RouteRequest): Promise<RouteOutcome> {
    const started = this.clock.now().getTime();
    const attempts: AttemptRecord[] = [];
    const outOfTime = () => this.clock.now().getTime() - started >= this.opts.maxTotalMs;
    let seq = 0;
    let last: RouteOutcome | undefined;

    const candidates = this.health.rank(req.candidates.filter((id) => this.adapters.has(id)));
    for (const pspId of candidates) {
      if (outOfTime()) break;
      const psp = this.adapter(pspId);
      const txnRef = `${req.baseRef}-${++seq}`;

      let r = await this.attempt(psp, req, txnRef, attempts);
      if (r.kind === 'TECHNICAL_DECLINE' && r.code === 'TIMEOUT' && !outOfTime()) {
        r = await this.resolveTimeout(psp, req, txnRef, attempts);
      }
      last = this.outcome(r, pspId, txnRef, attempts);
      if (r.kind !== 'TECHNICAL_DECLINE') return last;
    }

    return last ?? { result: { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }, attempts, hadTechnicalDecline: true };
  }

  /** After a timeout: wait, ask the PSP what happened, and retry once only if it never saw the debit. */
  private async resolveTimeout(psp: PspAdapter, req: RouteRequest, txnRef: string, attempts: AttemptRecord[]): Promise<PspResult> {
    for (let retried = false; ; retried = true) {
      await this.waitBeforeStatus();
      const s = await this.track(psp.id, txnRef, 'status', attempts, () => psp.status(txnRef));
      if (s.kind === 'SUCCESS' || s.kind === 'PENDING' || s.kind === 'BUSINESS_DECLINE') return s;
      if (retried) return TIMEOUT;
      const r = await this.attempt(psp, req, txnRef, attempts);
      if (!(r.kind === 'TECHNICAL_DECLINE' && r.code === 'TIMEOUT')) return r;
    }
  }

  private attempt(psp: PspAdapter, req: RouteRequest, txnRef: string, attempts: AttemptRecord[]): Promise<PspResult> {
    if (req.op === 'mandate') {
      if (!req.mandateRef) throw new Error('mandateRef required for mandate execution');
      const mandateRef = req.mandateRef;
      return this.track(psp.id, txnRef, 'execute', attempts, () =>
        psp.executeMandate({ txnRef, mandateRef, amountPaise: req.amountPaise }),
      );
    }
    if (!req.payerVpa) throw new Error('payerVpa required for collect');
    const payerVpa = req.payerVpa;
    return this.track(psp.id, txnRef, 'collect', attempts, () => psp.collect({ txnRef, payerVpa, amountPaise: req.amountPaise }));
  }

  private async track(
    pspId: string,
    txnRef: string,
    op: AttemptRecord['op'],
    attempts: AttemptRecord[],
    fn: () => Promise<PspResult>,
  ): Promise<PspResult> {
    const t0 = this.clock.now().getTime();
    let result: PspResult;
    try {
      result = await fn();
    } catch {
      // A thrown adapter error is an infrastructure failure, not a customer decline.
      result = { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
    }
    attempts.push({ pspId, txnRef, op, result, latencyMs: this.clock.now().getTime() - t0 });
    if (op !== 'status') this.health.record(pspId, result);
    return result;
  }

  private waitBeforeStatus(): Promise<void> {
    const [min, max] = this.opts.timeoutRetryDelayMs;
    return this.sleep(Math.round(min + this.opts.random() * (max - min)));
  }

  private outcome(result: PspResult, pspId: string, txnRef: string, attempts: AttemptRecord[]): RouteOutcome {
    return {
      result,
      pspId,
      txnRef,
      attempts,
      hadTechnicalDecline: attempts.some((a) => a.op !== 'status' && a.result.kind === 'TECHNICAL_DECLINE'),
    };
  }
}
