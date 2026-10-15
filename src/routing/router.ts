import type { Clock, Sleep } from '../clock.js';
import type { PaymentChannel, PspAdapter, PspResult, TxnContext } from '../psp/types.js';
import { PspRegistry } from '../psp/registry.js';
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
  /** Base payment the pre-debit notice was sent for (mandate executions); defaults to baseRef. */
  noticeRef?: string;
  /** One-off payments: how the customer pays (default UPI_COLLECT). Only PSPs supporting it are tried. */
  channel?: PaymentChannel;
  payerVpa?: string;
  customerPhone?: string;
  netbankingBankCode?: string;
  /** Stable prefix for txnRefs (e.g. the debit id) so attempts are traceable. */
  baseRef: string;
}

export interface AttemptRecord {
  /** Attempt on a PSP tried first only to probe its health (see HealthTracker.route). */
  probe?: boolean;
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
const PENDING: PspResult = { kind: 'PENDING' };
const isTimeout = (r: PspResult) => r.kind === 'TECHNICAL_DECLINE' && r.code === 'TIMEOUT';

/**
 * Cascading PSP router.
 *  - Business declines are final: never retried, never failed over.
 *  - A timeout is ambiguous (the bank may have debited), so we wait, check status, and
 *    only retry — on the same PSP with the same txnRef — if the PSP has no record of it.
 *  - Other technical declines are status-checked too, then fail over to the next-healthiest PSP
 *    with a fresh txnRef only if this PSP has nothing live for the request.
 */
export class Router {
  readonly psps: PspRegistry;
  private readonly opts: Required<RouterOptions>;

  constructor(
    psps: PspRegistry | PspAdapter[],
    private readonly health: HealthTracker,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    opts: RouterOptions = {},
  ) {
    this.psps = Array.isArray(psps) ? new PspRegistry(psps) : psps;
    this.opts = { timeoutRetryDelayMs: [3000, 5000], maxTotalMs: 30_000, random: Math.random, ...opts };
  }

  adapter(id: string): Promise<PspAdapter> {
    return this.psps.get(id);
  }

  /** Status lookup used by reconciliation of PENDING payments. */
  async status(pspId: string, txnRef: string, ctx: TxnContext): Promise<PspResult> {
    return (await this.adapter(pspId)).status(txnRef, ctx);
  }

  private ctxOf(req: RouteRequest): TxnContext {
    return req.op === 'mandate'
      ? { kind: 'MANDATE', mandateRef: req.mandateRef ?? '', noticeRef: req.noticeRef ?? req.baseRef }
      : { kind: 'COLLECT' };
  }

  async execute(req: RouteRequest): Promise<RouteOutcome> {
    const started = this.clock.now().getTime();
    const attempts: AttemptRecord[] = [];
    const outOfTime = () => this.clock.now().getTime() - started >= this.opts.maxTotalMs;
    let seq = 0;
    let last: RouteOutcome | undefined;

    // Candidates the registry can't resolve (e.g. a connection since deleted) are skipped.
    const resolved = new Map<string, PspAdapter>();
    const channel = req.channel ?? 'UPI_COLLECT';
    for (const id of req.candidates) {
      try {
        const psp = await this.psps.get(id);
        if (req.op === 'collect' && !psp.capabilities.channels.includes(channel)) continue;
        resolved.set(id, psp);
      } catch {
        // not routable
      }
    }
    const { order: candidates, probe } = this.health.routeWithProbe([...resolved.keys()]);
    for (const pspId of candidates) {
      if (outOfTime()) break;
      const psp = resolved.get(pspId)!;
      const txnRef = `${req.baseRef}-${++seq}`;

      // The request may have gone through at this PSP despite the error (e.g. a connection reset
      // after the PSP accepted it). Sending it again — via another PSP, or later with a fresh
      // reference — could debit the customer twice. So a technical decline only stands once the
      // PSP itself confirms nothing is live; if we can't confirm (lookup fails, no time left), the
      // outcome is unknown and is returned as PENDING, to be resolved by status checks.
      let r = await this.attempt(psp, req, txnRef, attempts);
      if (isTimeout(r)) r = outOfTime() ? PENDING : await this.resolveTimeout(psp, req, txnRef, attempts);
      if (r.kind === 'TECHNICAL_DECLINE' && !isTimeout(r)) {
        r = outOfTime() ? PENDING : await this.confirmBeforeFailover(psp, txnRef, r, attempts, this.ctxOf(req));
      }
      last = this.outcome(r, pspId, txnRef, attempts, probe);
      if (r.kind !== 'TECHNICAL_DECLINE') return last;
    }

    return last ?? { result: { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }, attempts, hadTechnicalDecline: attempts.length > 0 };
  }

  /**
   * After a timeout: wait, ask the PSP what happened, and retry once (same txnRef) only if it has
   * no record. TIMEOUT comes back only when the PSP twice confirmed it has no record — safe to fail over.
   */
  private async resolveTimeout(psp: PspAdapter, req: RouteRequest, txnRef: string, attempts: AttemptRecord[]): Promise<PspResult> {
    for (let retried = false; ; retried = true) {
      await this.waitBeforeStatus();
      const s = await this.lookup(psp, txnRef, this.ctxOf(req), attempts);
      if (s.kind === 'UNKNOWN') return PENDING;
      if (s.kind === 'SUCCESS' || s.kind === 'PENDING' || s.kind === 'BUSINESS_DECLINE') return s;
      if (retried) return TIMEOUT;
      const r = await this.attempt(psp, req, txnRef, attempts);
      if (!isTimeout(r)) return r;
    }
  }

  /** The live/terminal status if the PSP has one; the original decline only if the PSP confirms nothing is live. */
  private async confirmBeforeFailover(psp: PspAdapter, txnRef: string, decline: PspResult, attempts: AttemptRecord[], ctx: TxnContext): Promise<PspResult> {
    const s = await this.lookup(psp, txnRef, ctx, attempts);
    if (s.kind === 'UNKNOWN') return PENDING;
    return s.kind === 'SUCCESS' || s.kind === 'PENDING' || s.kind === 'BUSINESS_DECLINE' ? s : decline;
  }

  /** A status lookup; UNKNOWN when the lookup itself fails (recorded as a provider error). */
  private async lookup(psp: PspAdapter, txnRef: string, ctx: TxnContext, attempts: AttemptRecord[]): Promise<PspResult | { kind: 'UNKNOWN' }> {
    const t0 = this.clock.now().getTime();
    try {
      const s = await psp.status(txnRef, ctx);
      attempts.push({ pspId: psp.id, txnRef, op: 'status', result: s, latencyMs: this.clock.now().getTime() - t0 });
      return s;
    } catch {
      attempts.push({ pspId: psp.id, txnRef, op: 'status', result: { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }, latencyMs: this.clock.now().getTime() - t0 });
      return { kind: 'UNKNOWN' };
    }
  }

  private attempt(psp: PspAdapter, req: RouteRequest, txnRef: string, attempts: AttemptRecord[]): Promise<PspResult> {
    if (req.op === 'mandate') {
      if (!req.mandateRef) throw new Error('mandateRef required for mandate execution');
      const mandateRef = req.mandateRef;
      return this.track(psp.id, txnRef, 'execute', attempts, () =>
        psp.executeMandate({ txnRef, mandateRef, amountPaise: req.amountPaise, noticeRef: req.noticeRef ?? req.baseRef }),
      );
    }
    const channel = req.channel ?? 'UPI_COLLECT';
    if (channel === 'UPI_COLLECT' && !req.payerVpa) throw new Error('payerVpa required for a UPI collect');
    const { payerVpa, customerPhone, netbankingBankCode } = req;
    return this.track(psp.id, txnRef, 'collect', attempts, () =>
      psp.collect({
        txnRef,
        channel,
        amountPaise: req.amountPaise,
        ...(payerVpa ? { payerVpa } : {}),
        ...(customerPhone ? { customerPhone } : {}),
        ...(netbankingBankCode ? { netbankingBankCode } : {}),
      }),
    );
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

  private outcome(result: PspResult, pspId: string, txnRef: string, attempts: AttemptRecord[], probe: string | null): RouteOutcome {
    for (const a of attempts) if (a.pspId === probe) a.probe = true;
    return {
      result,
      pspId,
      txnRef,
      attempts,
      // A failed probe is a failure the router chose to risk, not one it recovered from.
      hadTechnicalDecline: attempts.some((a) => a.op !== 'status' && !a.probe && a.result.kind === 'TECHNICAL_DECLINE'),
    };
  }
}
