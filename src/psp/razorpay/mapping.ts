/**
 * Pure mapping from Razorpay API responses to our normalized PSP results. Conservative like the
 * Cashfree mapping: anything not positively final is PENDING (re-checked, never retried blindly).
 */
import type { BusinessDeclineCode, CustomerAction, PspResult, ReversalStatus, SettlementItem, TransactionInquiry } from '../types.js';

export interface RzpError {
  error?: { code?: string; description?: string; source?: string; reason?: string; step?: string } | null;
}

export interface RzpOrder {
  id: string;
  receipt?: string | null;
  status?: string;
}

export interface RzpPayment {
  id: string;
  order_id?: string | null;
  status?: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed' | string;
  captured?: boolean;
  amount?: number;
  method?: string;
  refund_status?: 'partial' | 'full' | null;
  created_at?: number;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_reason?: string | null;
  acquirer_data?: { rrn?: string | null; upi_transaction_id?: string | null } | null;
}

export interface RzpRefund {
  id: string;
  status?: 'pending' | 'processed' | 'failed' | string;
  created_at?: number;
}

/** Razorpay calls a customer without an email "void@razorpay.com" (its documented placeholder). */
export const NO_EMAIL = 'void@razorpay.com';

const BUSINESS_REASONS: Record<string, BusinessDeclineCode> = {
  insufficient_funds: 'INSUFFICIENT_FUNDS',
  incorrect_pin: 'WRONG_PIN',
  invalid_pin: 'WRONG_PIN',
  transaction_limit_exceeded: 'LIMIT_EXCEEDED',
  amount_exceeds_maximum_amount_allowed: 'LIMIT_EXCEEDED',
};

/** A failed payment: customer-side causes are business declines; bank/gateway trouble is technical. */
export function failureResult(p: Pick<RzpPayment, 'error_source' | 'error_reason'>): PspResult {
  const reason = (p.error_reason ?? '').toLowerCase();
  const mapped = BUSINESS_REASONS[reason];
  if (mapped) return { kind: 'BUSINESS_DECLINE', code: mapped };
  if (p.error_source === 'customer' || /cancel|declined_by_customer|payment_timed_out/.test(reason)) return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
  return { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
}

/** The most recent payment attempt on an order. */
export function latestPayment(payments: RzpPayment[]): RzpPayment | undefined {
  return [...payments].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
}

export function mapPayment(p: RzpPayment | undefined): PspResult {
  if (!p) return { kind: 'NOT_FOUND' };
  switch (p.status) {
    case 'captured':
      return { kind: 'SUCCESS', pspTxnId: p.id, ...(p.acquirer_data?.rrn ? { upiRrn: String(p.acquirer_data.rrn) } : {}) };
    case 'failed':
      return failureResult(p);
    case 'refunded':
      // Refunded without capture = Razorpay reversed an uncaptured payment: it failed for the merchant.
      return p.captured ? { kind: 'SUCCESS', pspTxnId: p.id } : { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
    default:
      return { kind: 'PENDING' }; // created, authorized (debited, capture pending) or undocumented
  }
}

function reversalFrom(refunds: RzpRefund[]): { status: ReversalStatus; initiatedAt?: Date; completedAt?: Date } {
  const at = (r?: RzpRefund) => (r?.created_at ? new Date(r.created_at * 1000) : undefined);
  const done = refunds.find((r) => r.status === 'processed');
  if (done) {
    const t = at(done);
    return { status: 'COMPLETED', ...(t ? { initiatedAt: t, completedAt: t } : {}) };
  }
  const pending = refunds.find((r) => r.status === 'pending');
  if (pending) {
    const t = at(pending);
    return { status: 'INITIATED', ...(t ? { initiatedAt: t } : {}) };
  }
  return { status: refunds.length ? 'UNKNOWN' : 'NONE' };
}

/** Money facts for an order's latest payment (refunds only matter for an uncaptured, debited payment). */
export function inquiryFromPayment(p: RzpPayment | undefined, refunds: RzpRefund[]): TransactionInquiry {
  if (!p) return { found: false };
  const rrn = p.acquirer_data?.rrn ? { upiRrn: String(p.acquirer_data.rrn) } : {};
  const code = p.error_code ? { failureCode: p.error_code } : {};
  switch (p.status) {
    case 'captured':
      return { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, ...rrn };
    case 'authorized':
      // The customer has paid; the merchant's account captures it (auto-capture) or Razorpay reverses it.
      return { found: true, outcome: 'PENDING', customerDebit: 'DEBITED', capture: 'UNKNOWN', reversal: { status: 'NONE' }, ...rrn };
    case 'refunded':
      if (p.captured) return { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, ...rrn };
      return { found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: reversalFrom(refunds), ...rrn };
    case 'failed': {
      const notDebited = failureResult(p).kind === 'BUSINESS_DECLINE';
      return { found: true, outcome: 'FAILED', customerDebit: notDebited ? 'NOT_DEBITED' : 'UNKNOWN', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' }, ...rrn, ...code };
    }
    default:
      return { found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: { status: 'NONE' } };
  }
}

export interface RzpReconItem {
  entity_id: string;
  type?: 'payment' | 'refund' | 'transfer' | 'adjustment' | string;
  debit?: number;
  credit?: number;
  amount?: number;
  fee?: number;
  tax?: number;
  settled?: boolean;
  settled_at?: number | null;
  settlement_id?: string | null;
  settlement_utr?: string | null;
  payment_id?: string | null;
  order_id?: string | null;
}

/** A settlement recon line (amounts already in paise). */
export function mapReconItem(r: RzpReconItem): SettlementItem {
  const kind: SettlementItem['kind'] = r.type === 'payment' ? 'PAYMENT' : r.type === 'refund' ? 'REFUND' : 'ADJUSTMENT';
  return {
    pspEventId: `${r.type ?? 'item'}:${r.entity_id}:${r.settlement_id ?? 'pending'}`,
    kind,
    pspPaymentId: kind === 'PAYMENT' ? r.entity_id : (r.payment_id ?? null),
    orderRef: null, // Razorpay's order id is not our reference; lines match by payment id
    amountPaise: r.amount ?? 0,
    feePaise: r.fee ?? 0,
    taxPaise: r.tax ?? 0,
    settledAmountPaise: (r.credit ?? 0) - (r.debit ?? 0),
    settlementId: r.settlement_id ?? null,
    utr: r.settlement_utr ?? null,
    settledAt: r.settled_at ? new Date(r.settled_at * 1000) : null,
  };
}

/** A non-2xx answer to a payment request. */
export function mapRequestError(status: number, body: RzpError | null): PspResult {
  if (status === 429 || status >= 500 || status === 401 || status === 403) return { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
  const e = body?.error;
  if (e?.reason || e?.source) return failureResult({ error_reason: e.reason ?? null, error_source: e.source ?? null });
  return { kind: 'BUSINESS_DECLINE', code: 'OTHER' }; // the request itself was refused; retrying can't help
}

/** What the customer must do after an S2S UPI payment request. */
export function actionFromUpiResponse(flow: 'collect' | 'intent', vpa: string | undefined, body: { next?: Array<{ action?: string; url?: string }> } | null): CustomerAction | null {
  if (flow === 'collect') return vpa ? { type: 'UPI_COLLECT', vpa } : null;
  const intent = body?.next?.find((n) => n.action === 'intent')?.url;
  return intent ? { type: 'UPI_INTENT', url: intent, appUrls: {} } : null;
}
