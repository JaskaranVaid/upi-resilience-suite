import { createHash } from 'node:crypto';
import { realSleep, type Clock, type Sleep } from '../clock.js';
import type {
  ComplaintRequest,
  ComplaintResult,
  ComplaintStatus,
  ComplaintStatusResult,
  CollectRequest,
  CustomerAction,
  ExecuteMandateRequest,
  MandateLookup,
  NoticeResult,
  SettlementItem,
  PspCapabilities,
  PreDebitNoticeRequest,
  PspAdapter,
  PspResult,
  TransactionInquiry,
  TxnContext,
} from './types.js';

export const MOCK_CAPABILITIES: PspCapabilities = {
  minNoticeMs: 0,
  maxNoticeLeadMs: null,
  udirComplaints: true,
  portableMandates: true,
  collectRequires: [],
  channels: ['UPI_COLLECT', 'UPI_INTENT', 'UPI_QR', 'NETBANKING', 'CARD'],
  autopay: true,
  settlementReports: false,
};

/** A plausible customer action for a simulated payment (never a real PSP or bank URL). */
function mockAction(req: CollectRequest, pspId: string): CustomerAction {
  const upi = `upi://pay?pa=merchant.mock@${pspId}&pn=Mock%20Merchant&tr=${encodeURIComponent(req.txnRef)}&am=${(req.amountPaise / 100).toFixed(2)}&cu=INR`;
  switch (req.channel) {
    case 'UPI_INTENT':
      return { type: 'UPI_INTENT', url: upi, appUrls: {} };
    case 'UPI_QR':
      return { type: 'UPI_QR', qrData: upi };
    case 'NETBANKING':
      return req.netbankingBankCode
        ? { type: 'REDIRECT', url: `https://mock-bank.invalid/netbanking/${encodeURIComponent(req.netbankingBankCode)}?ref=${encodeURIComponent(req.txnRef)}` }
        : { type: 'PSP_CHECKOUT', provider: 'mock', environment: 'sandbox', params: { reference: req.txnRef } };
    default:
      return { type: 'PSP_CHECKOUT', provider: 'mock', environment: 'sandbox', params: { reference: req.txnRef } };
  }
}

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
  /** Override capabilities (e.g. to behave like a provider without UDIR complaints). */
  capabilities?: Partial<PspCapabilities>;
  /**
   * Simulate a settlement report: every success settles the next IST day at 10:00, net of
   * `feeBps`. Used for test-mode connections so reconciliation works end to end.
   */
  autoSettle?: { clock: Clock; feeBps?: number };
  sleep?: Sleep;
  /** Act out TEST_SCENARIOS for amounts ending in those paise (test mode; never on a real PSP). */
  scenarios?: boolean;
}

/**
 * Test-mode scenarios, chosen by the paise of the amount (₹2,500.51 → 51). They let a developer
 * see every outcome Merchantflo handles without a real bank: declines, recoveries, pending
 * payments, debits without capture and late captures.
 */
export const TEST_SCENARIOS = [
  { paise: 51, outcome: 'Failed — not charged', description: "The customer's bank declines (insufficient funds). Never retried." },
  { paise: 52, outcome: 'Succeeded via failover (needs 2 PSPs)', description: 'The bank is down at the first PSP tried; Merchantflo fails over to your next PSP and the payment succeeds. With one PSP it fails, not charged.' },
  { paise: 53, outcome: 'Succeeded after a status check', description: "The PSP times out, but the payment went through; Merchantflo's status check finds the success instead of charging again." },
  { paise: 54, outcome: 'Verifying, then failed — not charged', description: 'The PSP times out and the payment never reached the bank; status checks find nothing and the payment fails.' },
  { paise: 55, outcome: 'Debited, then reversed', description: "Reported failed although the customer was debited; the bank's auto-reversal is tracked to completion." },
  { paise: 56, outcome: 'Debited, not captured', description: 'Reported failed although the customer was debited, and no reversal appears; it stays under verification and then needs action in the Dispute Desk.' },
  { paise: 57, outcome: 'Captured after failure', description: 'Reported failed, but the PSP captured it after all (late success); flagged for review.' },
] as const;

export interface MockCall {
  op: 'notice' | 'execute' | 'collect' | 'status' | 'inquire' | 'complaint' | 'complaintStatus';
  txnRef: string;
  amountPaise?: number;
  ctx?: TxnContext;
  noticeRef?: string;
}

/**
 * In-memory PSP for tests, local development and demos. Behaviour is either scripted
 * (queue of results) or probabilistic with a seeded RNG, so runs are reproducible.
 */
export class MockPsp implements PspAdapter {
  readonly mode = 'MOCK' as const;
  readonly capabilities: PspCapabilities;
  readonly scenarios: boolean;
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
    this.capabilities = { ...MOCK_CAPABILITIES, ...(opts.autoSettle ? { settlementReports: true } : {}), ...opts.capabilities };
    this.rngState = opts.seed ?? 42;
    this.scenarios = opts.scenarios ?? false;
  }

  private readonly mandateStatuses = new Map<string, MandateLookup>();
  private readonly settlementItems: SettlementItem[] = [];

  /** Lines this mock's settlement report returns (filtered by settledAt). Turns reporting on. */
  addSettlements(...items: SettlementItem[]): void {
    this.capabilities.settlementReports = true;
    this.settlementItems.push(...items);
  }

  async settlements(range: { from: Date; to: Date }): Promise<SettlementItem[]> {
    return this.settlementItems.filter((s) => s.settledAt && s.settledAt >= range.from && s.settledAt < range.to);
  }

  /** autoSettle: a success settles the next IST day at 10:00 (T+1), net of the configured fee. */
  private autoSettleSuccess(txnRef: string, pspTxnId: string, amountPaise: number): void {
    const auto = this.opts.autoSettle;
    if (!auto) return;
    const at = auto.clock.now();
    const nextDay = new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const settledAt = new Date(new Date(`${nextDay}T10:00:00+05:30`).getTime() + 86_400_000);
    const fee = Math.round((amountPaise * (auto.feeBps ?? 0)) / 10_000);
    this.settlementItems.push({
      pspEventId: `auto:${pspTxnId}`, kind: 'PAYMENT', pspPaymentId: pspTxnId, orderRef: txnRef, amountPaise,
      feePaise: fee, taxPaise: 0, settledAmountPaise: amountPaise - fee, settlementId: `mockstl-${nextDay}`, utr: `MOCKUTR${nextDay.replaceAll('-', '')}`, settledAt,
    });
  }

  /** What mandateStatus() reports for a mandate (default ACTIVE). */
  setMandateStatus(mandateRef: string, status: MandateLookup): void {
    this.mandateStatuses.set(mandateRef, status);
  }

  async mandateStatus(mandateRef: string): Promise<MandateLookup> {
    return this.mandateStatuses.get(mandateRef) ?? 'ACTIVE';
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

  async executeMandate(req: ExecuteMandateRequest): Promise<PspResult> {
    this.calls.push({ op: 'execute', txnRef: req.txnRef, amountPaise: req.amountPaise, noticeRef: req.noticeRef });
    return this.respond(req.txnRef, req.amountPaise);
  }

  async collect(req: CollectRequest): Promise<PspResult> {
    this.calls.push({ op: 'collect', txnRef: req.txnRef, amountPaise: req.amountPaise });
    const result = await this.respond(req.txnRef, req.amountPaise);
    if (req.channel === 'UPI_COLLECT' || result.kind !== 'SUCCESS') return result;
    // Intent/QR/redirect/checkout payments need the customer to act first: report PENDING with the
    // action, while the ledger keeps the success a later status check will find (customer paid).
    return { kind: 'PENDING', action: mockAction(req, this.id) };
  }

  async status(txnRef: string, ctx?: TxnContext): Promise<PspResult> {
    this.calls.push({ op: 'status', txnRef, ...(ctx ? { ctx } : {}) });
    return this.ledger.get(txnRef) ?? { kind: 'NOT_FOUND' };
  }

  async inquire(txnRef: string, ctx?: TxnContext): Promise<TransactionInquiry> {
    this.calls.push({ op: 'inquire', txnRef, ...(ctx ? { ctx } : {}) });
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
        return { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, ...ids, pspPaymentId: r.pspTxnId };
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

  private async respond(txnRef: string, amountPaise: number): Promise<PspResult> {
    if (this.opts.latencyMs) await (this.opts.sleep ?? realSleep)(this.opts.latencyMs);
    const existing = this.ledger.get(txnRef);
    if (existing?.kind === 'SUCCESS') return existing; // idempotent on txnRef, like real PSPs

    const scripted = this.script.length > 0;
    const step = (scripted ? undefined : this.scenarioStep(txnRef, amountPaise)) ?? this.script.shift() ?? this.random();
    const { settleAs, ...result } = step as MockStep;
    // Unscripted successes carry the RRN inline like most real PSPs; scripted ones stay exact.
    if (!scripted && result.kind === 'SUCCESS') result.upiRrn = mockRrn(this.id, txnRef);
    const settled = settleAs ?? (result.kind === 'TECHNICAL_DECLINE' && result.code === 'TIMEOUT' ? null : (result as PspResult));
    if (settled) this.ledger.set(txnRef, settled);
    if (settled?.kind === 'SUCCESS') this.autoSettleSuccess(txnRef, settled.pspTxnId, amountPaise);
    return result as PspResult;
  }

  /** The TEST_SCENARIOS step for this amount, if scenarios are on and it is a magic amount. */
  private scenarioStep(txnRef: string, amountPaise: number): MockStep | undefined {
    if (!this.scenarios) return undefined;
    const bankDown: MockStep = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
    const debited = (status: 'NONE' | 'INITIATED' | 'COMPLETED'): TransactionInquiry => ({
      found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status },
    });
    switch (amountPaise % 100) {
      case 51:
        return { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' };
      case 52:
        return /-1$/.test(txnRef) ? bankDown : undefined; // only the first PSP tried
      case 53:
        return { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: this.ok() };
      case 54:
        return { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' };
      case 55:
        this.scriptInquiry(txnRef, [debited('NONE'), debited('INITIATED'), debited('COMPLETED')]);
        return bankDown;
      case 56:
        this.scriptInquiry(txnRef, [debited('NONE')]);
        return bankDown;
      case 57:
        this.scriptInquiry(txnRef, [{ found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, pspPaymentId: `${this.id}-late-${txnRef}` }]);
        return bankDown;
      default:
        return undefined;
    }
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
