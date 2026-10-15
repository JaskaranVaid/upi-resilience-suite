/**
 * Pure mapping from Cashfree API (v2026-01-01) responses to our normalized PSP results.
 * Conservative by design: anything not positively recognised as final is PENDING, so it is
 * re-checked and never retried blindly. See docs/superpowers/specs/2026-10-03-real-psp-cashfree-design.md.
 */
import { createHash } from 'node:crypto';
import type { BusinessDeclineCode, CollectRequest, CustomerAction, ReversalStatus, PspResult, SettlementItem, TransactionInquiry } from '../types.js';

export const toRupees = (paise: number) => Number((paise / 100).toFixed(2));
export const toPaise = (rupees: unknown) => Math.round(Number(rupees) * 100);

/** Deterministic UUID-format idempotency key: the same operation on the same reference always replays. */
export function idempotencyKey(op: string, ref: string): string {
  const h = createHash('sha256').update(`cashfree:${op}:${ref}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Cashfree customer_id must be 3–50 alphanumerics; derive a stable one from the payer VPA. */
export function customerIdFor(payerVpa: string): string {
  return `c${createHash('sha256').update(payerVpa.toLowerCase()).digest('hex').slice(0, 24)}`;
}

/**
 * Classify a failure reason. Customer-side causes are business declines (never retried);
 * anything else is technical (retried within the mandate budget).
 */
export function classifyFailure(reason: string | null | undefined): { kind: 'BUSINESS'; code: BusinessDeclineCode } | { kind: 'TECHNICAL' } {
  const r = (reason ?? '').toLowerCase();
  if (/insufficient|not enough balance|low balance/.test(r)) return { kind: 'BUSINESS', code: 'INSUFFICIENT_FUNDS' };
  if (/revok|paused|suspend|mandate (is )?(not active|inactive|cancel)/.test(r)) return { kind: 'BUSINESS', code: 'MANDATE_REVOKED' };
  if (/limit|exceed/.test(r)) return { kind: 'BUSINESS', code: 'LIMIT_EXCEEDED' };
  if (/\bpin\b|mpin/.test(r)) return { kind: 'BUSINESS', code: 'WRONG_PIN' };
  if (/declined by (customer|user|payer)|rejected by (customer|user|payer)|expired|user dropped/.test(r)) return { kind: 'BUSINESS', code: 'OTHER' };
  return { kind: 'TECHNICAL' };
}

function failureResult(reason: string | null | undefined, customerSide: boolean): PspResult {
  const c = classifyFailure(reason);
  if (c.kind === 'BUSINESS') return { kind: 'BUSINESS_DECLINE', code: c.code };
  if (customerSide) return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
  return { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
}

// ── UPI collect (orders) ───────────────────────────────────────────────────────────────

export interface CfOrderPayment {
  cf_payment_id?: string | number;
  payment_status?: string;
  payment_time?: string;
  bank_reference?: string | null;
  is_captured?: boolean;
  error_details?: { error_code?: string; error_reason?: string; error_source?: string; error_description?: string } | null;
}

export interface CfRefund {
  refund_type?: string;
  refund_status?: string;
  created_at?: string;
  processed_at?: string | null;
}

/** The order's most recent payment attempt. */
export function latestPayment(payments: CfOrderPayment[]): CfOrderPayment | undefined {
  return [...payments].sort((a, b) => Date.parse(b.payment_time ?? '') - Date.parse(a.payment_time ?? ''))[0];
}

const errorText = (p: CfOrderPayment) => [p.error_details?.error_reason, p.error_details?.error_description].filter(Boolean).join(' ');

export function mapOrderPayment(p: CfOrderPayment | undefined): PspResult {
  if (!p) return { kind: 'NOT_FOUND' };
  switch (p.payment_status) {
    case 'SUCCESS':
      return { kind: 'SUCCESS', pspTxnId: String(p.cf_payment_id ?? ''), ...(p.bank_reference ? { upiRrn: String(p.bank_reference) } : {}) };
    case 'FAILED':
      return failureResult(errorText(p), p.error_details?.error_source === 'customer');
    case 'USER_DROPPED':
    case 'VOID':
    case 'CANCELLED':
      return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
    default:
      return { kind: 'PENDING' }; // PENDING, NOT_ATTEMPTED, or anything undocumented
  }
}

const AUTO_REFUND_TYPES = new Set(['PAYMENT_AUTO_REFUND', 'UNRECONCILED_AUTO_REFUND']);
const REFUND_IN_FLIGHT = new Set(['PENDING', 'PENDING_APPROVAL', 'ONHOLD']);

/** Bank/PSP auto-reversal facts from the order's refunds (merchant refunds are out of scope). */
export function reversalFromRefunds(refunds: CfRefund[]): { status: ReversalStatus; initiatedAt?: Date; completedAt?: Date } | null {
  const auto = refunds.filter((r) => AUTO_REFUND_TYPES.has(r.refund_type ?? ''));
  if (auto.length === 0) return null;
  const done = auto.find((r) => r.refund_status === 'SUCCESS');
  const date = (s?: string | null) => (s ? new Date(s) : undefined);
  if (done) {
    const initiatedAt = date(done.created_at);
    const completedAt = date(done.processed_at) ?? date(done.created_at);
    return { status: 'COMPLETED', ...(initiatedAt ? { initiatedAt } : {}), ...(completedAt ? { completedAt } : {}) };
  }
  const inFlight = auto.find((r) => REFUND_IN_FLIGHT.has(r.refund_status ?? ''));
  if (inFlight) {
    const initiatedAt = date(inFlight.created_at);
    return { status: 'INITIATED', ...(initiatedAt ? { initiatedAt } : {}) };
  }
  return { status: 'UNKNOWN' }; // cancelled/rejected auto-refund: needs a human
}

export function inquiryFromOrder(payments: CfOrderPayment[], refunds: CfRefund[]): TransactionInquiry {
  const p = latestPayment(payments);
  const reversal = reversalFromRefunds(refunds);
  if (!p && !reversal) return { found: false };
  const rrn = p?.bank_reference ? { upiRrn: String(p.bank_reference) } : {};
  const failureCode = p?.error_details?.error_code ? { failureCode: p.error_details.error_code } : {};

  if (p?.payment_status === 'SUCCESS') {
    const id = p.cf_payment_id != null ? { pspPaymentId: String(p.cf_payment_id) } : {};
    return { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: p.is_captured === false ? 'UNKNOWN' : 'CAPTURED', reversal: { status: 'NONE' }, ...rrn, ...id };
  }
  if (!p || ['FAILED', 'USER_DROPPED', 'VOID', 'CANCELLED'].includes(p.payment_status ?? '')) {
    if (reversal) {
      // An auto-refund exists only because the customer was debited without a successful payment.
      return { found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal, ...rrn, ...failureCode };
    }
    // Never-completed attempts and customer-side failures didn't debit; other failures we can't tell.
    const notDebited = p!.payment_status !== 'FAILED' || p!.error_details?.error_source === 'customer' || classifyFailure(errorText(p!)).kind === 'BUSINESS';
    return {
      found: true,
      outcome: 'FAILED',
      customerDebit: notDebited ? 'NOT_DEBITED' : 'UNKNOWN',
      capture: 'NOT_CAPTURED',
      reversal: { status: 'NONE' },
      ...rrn,
      ...failureCode,
    };
  }
  return { found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: reversal ?? { status: 'NONE' }, ...rrn };
}

// ── Order Pay (one-off payment channels) ──────────────────────────────────────────────

/** Response of POST /orders/sessions (Order Pay). */
export interface CfOrderPay {
  action?: string;
  cf_payment_id?: string | number;
  channel?: string;
  data?: { url?: string | null; payload?: Record<string, unknown> | null } | null;
}

/** The Order Pay payment_method for a channel, or null when the customer uses Cashfree's checkout. */
export function orderPayMethod(req: CollectRequest): Record<string, unknown> | null {
  switch (req.channel) {
    case 'UPI_COLLECT':
      return { upi: { channel: 'collect', upi_id: req.payerVpa } };
    case 'UPI_INTENT':
      return { upi: { channel: 'link' } };
    case 'UPI_QR':
      return { upi: { channel: 'qrcode' } };
    case 'NETBANKING': {
      if (!req.netbankingBankCode) return null;
      const code = Number(req.netbankingBankCode);
      return { netbanking: { channel: 'link', ...(Number.isInteger(code) ? { netbanking_bank_code: code } : { netbanking_bank_name: req.netbankingBankCode }) } };
    }
    case 'CARD':
      return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** What the customer must do, from the Order Pay response (deeplinks and QR data passed through unmodified). */
export function customerActionFor(
  req: CollectRequest,
  pay: CfOrderPay | null,
  session: { sessionId: string; environment: 'sandbox' | 'production' },
): CustomerAction | null {
  const payload = pay?.data?.payload ?? {};
  switch (req.channel) {
    case 'UPI_COLLECT':
      return { type: 'UPI_COLLECT', vpa: req.payerVpa! };
    case 'UPI_INTENT': {
      // App-specific deeplinks use their own schemes (tez://, phonepe://, paytmmp://…): keep any URL.
      const apps = Object.fromEntries(Object.entries(payload).filter(([k, v]) => k !== 'default' && typeof v === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(v))) as Record<string, string>;
      const url = str(payload.default) ?? Object.values(apps)[0];
      return url ? { type: 'UPI_INTENT', url, appUrls: apps } : null;
    }
    case 'UPI_QR': {
      const qrData = str(payload.qrData) ?? (str(payload.qrcode)?.startsWith('upi:') ? str(payload.qrcode) : undefined);
      const qrImage = str(payload.qrcode) && !str(payload.qrcode)!.startsWith('upi:') ? str(payload.qrcode) : undefined;
      return qrData || qrImage ? { type: 'UPI_QR', ...(qrData ? { qrData } : {}), ...(qrImage ? { qrImage } : {}) } : null;
    }
    case 'NETBANKING':
    case 'CARD': {
      const url = str(pay?.data?.url);
      if (pay && url) return { type: 'REDIRECT', url };
      return { type: 'PSP_CHECKOUT', provider: 'cashfree', environment: session.environment, params: { paymentSessionId: session.sessionId, orderId: req.txnRef } };
    }
  }
}

// ── Settlement reconciliation (POST /settlement/recon) ─────────────────────────────────

export interface CfReconItem {
  event_details?: { event_id?: string | number; event_type?: string; event_amount?: number; event_settlement_amount?: number; event_service_charge?: number; event_service_tax?: number; sale_type?: string } | null;
  order_details?: { order_id?: string | null } | null;
  payment_details?: { cf_payment_id?: string | number | null; payment_amount?: number } | null;
  settlement_details?: { cf_settlement_id?: string | number | null; settlement_utr?: string | null; settlement_date?: string | null } | null;
}

export function mapReconItem(r: CfReconItem): SettlementItem {
  const e = r.event_details ?? {};
  const s = r.settlement_details ?? {};
  const type = (e.event_type ?? '').toUpperCase();
  const kind: SettlementItem['kind'] = type === 'PAYMENT' ? 'PAYMENT' : type === 'REFUND' ? 'REFUND' : 'ADJUSTMENT';
  const settled = toPaise(e.event_settlement_amount ?? 0);
  return {
    pspEventId: String(e.event_id ?? `${s.cf_settlement_id ?? 'x'}:${r.payment_details?.cf_payment_id ?? 'x'}:${type}`),
    kind,
    pspPaymentId: r.payment_details?.cf_payment_id != null ? String(r.payment_details.cf_payment_id) : null,
    orderRef: r.order_details?.order_id ?? null,
    amountPaise: toPaise(e.event_amount ?? r.payment_details?.payment_amount ?? 0),
    feePaise: toPaise(e.event_service_charge ?? 0),
    taxPaise: toPaise(e.event_service_tax ?? 0),
    settledAmountPaise: e.sale_type === 'DEBIT' ? -Math.abs(settled) : settled,
    settlementId: s.cf_settlement_id != null ? String(s.cf_settlement_id) : null,
    utr: s.settlement_utr ?? null,
    settledAt: s.settlement_date ? new Date(s.settlement_date) : null,
  };
}

// ── UPI AutoPay controlled execution ───────────────────────────────────────────────────

export interface CfExecution {
  cf_payment_id?: string | number;
  cf_txn_id?: string | number;
  execution_status?: string;
  payment_status?: string;
  failure_details?: { failure_reason?: string | null; failure_error_code?: string | null } | null;
}

const FAILED_STATES = new Set(['FAILED', 'CANCELLED']);

export function mapExecution(e: CfExecution): PspResult {
  if (e.payment_status === 'SUCCESS') return { kind: 'SUCCESS', pspTxnId: String(e.cf_txn_id ?? e.cf_payment_id ?? '') };
  if (FAILED_STATES.has(e.payment_status ?? '') || FAILED_STATES.has(e.execution_status ?? '')) {
    return failureResult(e.failure_details?.failure_reason, false);
  }
  return { kind: 'PENDING' }; // INITIALIZED, PENDING, or undocumented
}

export function inquiryFromExecution(e: CfExecution | null): TransactionInquiry {
  if (!e) return { found: false };
  const r = mapExecution(e);
  const failureCode = e.failure_details?.failure_error_code ? { failureCode: e.failure_details.failure_error_code } : {};
  switch (r.kind) {
    case 'SUCCESS':
      return { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, pspPaymentId: r.pspTxnId };
    case 'BUSINESS_DECLINE':
      return { found: true, outcome: 'FAILED', customerDebit: 'NOT_DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' }, ...failureCode };
    case 'TECHNICAL_DECLINE':
      // Subscription reversals aren't exposed by the API: debit stays unknown and is watched.
      return { found: true, outcome: 'FAILED', customerDebit: 'UNKNOWN', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' }, ...failureCode };
    default:
      return { found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: { status: 'NONE' } };
  }
}

// ── HTTP errors on debit / collect requests ────────────────────────────────────────────

export interface CfError {
  code?: string;
  message?: string;
  type?: string;
}

/** Map a non-2xx response to a debit/collect request. */
export function mapRequestError(status: number, body: CfError | null): PspResult {
  const code = body?.code ?? '';
  const message = (body?.message ?? '').toLowerCase();
  if (status === 429 || status >= 500 || status === 401 || status === 403 || status === 422) {
    return { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
  }
  if (code === 'Prev_Execution_In_Progress' || /previous execution is in progress/.test(message)) return { kind: 'PENDING' };
  if (/max number of executions/.test(message)) return { kind: 'BUSINESS_DECLINE', code: 'LIMIT_EXCEEDED' };
  if (/no successful notification/.test(message)) return { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
  return { kind: 'BUSINESS_DECLINE', code: 'OTHER' }; // the request itself was rejected; retrying can't help
}
