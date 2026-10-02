import { realSleep, type Sleep } from '../clock.js';
import type { NoticeResult, PreDebitNoticeRequest, PspAdapter, PspResult } from './types.js';

/** A scripted response; `settleAs` is what a later status() reports (e.g. a timeout that actually succeeded). */
export type MockStep = PspResult & { settleAs?: PspResult };

export interface MockRates {
  /** Probabilities for unscripted calls; remainder is SUCCESS. */
  timeout?: number;
  bankUnavailable?: number;
  businessDecline?: number;
  /** Probability that a TIMEOUT actually went through at the bank. */
  timeoutActuallySucceeded?: number;
}

export interface MockPspOptions {
  script?: MockStep[];
  rates?: MockRates;
  latencyMs?: number;
  seed?: number;
  failNotices?: boolean;
  sleep?: Sleep;
}

export interface MockCall {
  op: 'notice' | 'execute' | 'collect' | 'status';
  txnRef: string;
  amountPaise?: number;
}

/**
 * In-memory PSP for tests, local development and demos. Behaviour is either scripted
 * (queue of results) or probabilistic with a seeded RNG, so runs are reproducible.
 */
export class MockPsp implements PspAdapter {
  readonly calls: MockCall[] = [];
  readonly notices: PreDebitNoticeRequest[] = [];
  private readonly script: MockStep[];
  private readonly ledger = new Map<string, PspResult>();
  private rngState: number;
  private txnCounter = 0;

  constructor(
    readonly id: string,
    private readonly opts: MockPspOptions = {},
  ) {
    this.script = [...(opts.script ?? [])];
    this.rngState = opts.seed ?? 42;
  }

  /** Change behaviour at runtime (demo: "take PSP A down"). */
  setRates(rates: MockRates): void {
    this.opts.rates = rates;
  }

  enqueue(...steps: MockStep[]): void {
    this.script.push(...steps);
  }

  /** Resolve an in-flight transaction (what a later status() call reports). */
  settle(txnRef: string, result: PspResult): void {
    this.ledger.set(txnRef, result);
  }

  async sendPreDebitNotice(req: PreDebitNoticeRequest): Promise<NoticeResult> {
    this.calls.push({ op: 'notice', txnRef: req.noticeRef, amountPaise: req.amountPaise });
    if (this.opts.failNotices) return { ok: false, reason: 'PSP notice API unavailable' };
    this.notices.push(req);
    return { ok: true };
  }

  async executeMandate(req: { txnRef: string; mandateRef: string; amountPaise: number }): Promise<PspResult> {
    this.calls.push({ op: 'execute', txnRef: req.txnRef, amountPaise: req.amountPaise });
    return this.respond(req.txnRef);
  }

  async collect(req: { txnRef: string; payerVpa: string; amountPaise: number }): Promise<PspResult> {
    this.calls.push({ op: 'collect', txnRef: req.txnRef, amountPaise: req.amountPaise });
    return this.respond(req.txnRef);
  }

  async status(txnRef: string): Promise<PspResult> {
    this.calls.push({ op: 'status', txnRef });
    return this.ledger.get(txnRef) ?? { kind: 'NOT_FOUND' };
  }

  private async respond(txnRef: string): Promise<PspResult> {
    if (this.opts.latencyMs) await (this.opts.sleep ?? realSleep)(this.opts.latencyMs);
    const existing = this.ledger.get(txnRef);
    if (existing?.kind === 'SUCCESS') return existing; // idempotent on txnRef, like real PSPs

    const step = this.script.shift() ?? this.random();
    const { settleAs, ...result } = step as MockStep;
    const settled = settleAs ?? (result.kind === 'TECHNICAL_DECLINE' && result.code === 'TIMEOUT' ? null : result);
    if (settled) this.ledger.set(txnRef, settled);
    return result as PspResult;
  }

  private random(): MockStep {
    const r = this.opts.rates ?? {};
    const x = this.rand();
    let acc = r.timeout ?? 0;
    if (x < acc) {
      return this.rand() < (r.timeoutActuallySucceeded ?? 0)
        ? { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: this.ok() }
        : { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' };
    }
    if (x < (acc += r.bankUnavailable ?? 0)) return { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
    if (x < (acc += r.businessDecline ?? 0)) return { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' };
    return this.ok();
  }

  private ok(): PspResult {
    return { kind: 'SUCCESS', pspTxnId: `${this.id}-${++this.txnCounter}` };
  }

  /** mulberry32 */
  private rand(): number {
    let t = (this.rngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
