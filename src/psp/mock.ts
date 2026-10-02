import { createHash } from 'node:crypto';
import { realSleep, type Sleep } from '../clock.js';
import type {
  ComplaintRequest,
  ComplaintResult,
  ComplaintStatus,
  ComplaintStatusResult,
  NoticeResult,
  PreDebitNoticeRequest,
  PspAdapter,
  PspResult,
  TransactionInquiry,
} from './types.js';

/** Deterministic fake 12-digit UPI reference for a PSP + txnRef. */
export function mockRrn(pspId: string, txnRef: string): string {
  const n = BigInt(`0x${createHash('sha256').update(`${pspId}:${txnRef}`).digest('hex').slice(0, 15)}`) % 10n ** 12n;
  return n.toString().padStart(12, '0');
}

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
  /** inquire() throws, simulating an enquiry API outage. */
  failInquiries?: boolean;
  /** raiseComplaint() returns a retryable failure. */
  failComplaints?: boolean;
  /** Statuses each complaint reports on successive complaintStatus() calls; last repeats. */
  complaintScript?: ComplaintStatus[];
  sleep?: Sleep;
}

export interface MockCall {
  op: 'notice' | 'execute' | 'collect' | 'status' | 'inquire' | 'complaint' | 'complaintStatus';
  txnRef: string;
  amountPaise?: number;
}

/**
 * In-memory PSP for tests, local development and demos. Behaviour is either scripted
 * (queue of results) or probabilistic with a seeded RNG, so runs are reproducible.
 */
export class MockPsp implements PspAdapter {
  readonly mode = 'MOCK' as const;
  readonly calls: MockCall[] = [];
  readonly notices: PreDebitNoticeRequest[] = [];
  private readonly script: MockStep[];
  private readonly ledger = new Map<string, PspResult>();
  private readonly inquiryScripts = new Map<string, TransactionInquiry[]>();
  private readonly pendingInquiryScripts: TransactionInquiry[][] = [];
  private readonly complaints = new Map<string, { ref: string; reads: number }>();
  private complaintCounter = 0;
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

  /** Inquiries for txnRef, played in order; the last one repeats. */
  scriptInquiry(txnRef: string, steps: TransactionInquiry[]): void {
    this.inquiryScripts.set(txnRef, [...steps]);
  }

  /** Bind a script to the next txnRef inquired that has no script (txnRefs are often random). */
  scriptNextInquiry(steps: TransactionInquiry[]): void {
    this.pendingInquiryScripts.push([...steps]);
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

  async inquire(txnRef: string): Promise<TransactionInquiry> {
    this.calls.push({ op: 'inquire', txnRef });
    if (this.opts.failInquiries) throw new Error('mock enquiry API unavailable');

    let script = this.inquiryScripts.get(txnRef);
    if (!script && this.pendingInquiryScripts.length > 0) {
      script = this.pendingInquiryScripts.shift()!;
      this.inquiryScripts.set(txnRef, script);
    }
    if (script) {
      const step = script.length > 1 ? script.shift()! : script[0]!;
      return step.found ? { upiRrn: mockRrn(this.id, txnRef), ...step } : step;
    }

    const r = this.ledger.get(txnRef);
    if (!r || r.kind === 'NOT_FOUND') return { found: false };
    const ids = { upiRrn: mockRrn(this.id, txnRef), npciTxnId: `MOCK${this.id}${txnRef}`.replace(/[^A-Za-z0-9]/g, '') };
    switch (r.kind) {
      case 'SUCCESS':
        return { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, ...ids };
      case 'PENDING':
        return { found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: { status: 'NONE' }, ...ids };
      case 'TECHNICAL_DECLINE':
      case 'BUSINESS_DECLINE':
        return {
          found: true, outcome: 'FAILED', customerDebit: 'NOT_DEBITED', capture: 'NOT_CAPTURED',
          reversal: { status: 'NONE' }, ...ids, failureCode: r.code,
        };
    }
  }

  async raiseComplaint(req: ComplaintRequest): Promise<ComplaintResult> {
    this.calls.push({ op: 'complaint', txnRef: req.txnRef, amountPaise: req.amountPaise });
    if (this.opts.failComplaints) return { ok: false, reason: 'mock UDIR API unavailable', retryable: true };
    let c = this.complaints.get(req.idempotencyKey);
    if (!c) {
      c = { ref: `MOCK-UDIR-${String(++this.complaintCounter).padStart(6, '0')}`, reads: 0 };
      this.complaints.set(req.idempotencyKey, c);
    }
    return { ok: true, pspComplaintRef: c.ref, status: 'SUBMITTED' };
  }

  async complaintStatus(pspComplaintRef: string): Promise<ComplaintStatusResult> {
    this.calls.push({ op: 'complaintStatus', txnRef: pspComplaintRef });
    const c = [...this.complaints.values()].find((x) => x.ref === pspComplaintRef);
    if (!c) return { ok: false, reason: 'unknown complaint' };
    const script = this.opts.complaintScript ?? ['IN_PROGRESS'];
    const status = script[Math.min(c.reads++, script.length - 1)]!;
    return { ok: true, status, updatedAt: new Date() };
  }

  private async respond(txnRef: string): Promise<PspResult> {
    if (this.opts.latencyMs) await (this.opts.sleep ?? realSleep)(this.opts.latencyMs);
    const existing = this.ledger.get(txnRef);
    if (existing?.kind === 'SUCCESS') return existing; // idempotent on txnRef, like real PSPs

    const scripted = this.script.length > 0;
    const step = this.script.shift() ?? this.random();
    const { settleAs, ...result } = step as MockStep;
    // Unscripted successes carry the RRN inline like most real PSPs; scripted ones stay exact.
    if (!scripted && result.kind === 'SUCCESS') result.upiRrn = mockRrn(this.id, txnRef);
    const settled = settleAs ?? (result.kind === 'TECHNICAL_DECLINE' && result.code === 'TIMEOUT' ? null : (result as PspResult));
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
