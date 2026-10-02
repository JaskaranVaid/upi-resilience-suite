/**
 * Normalized PSP contract. Real adapters (Razorpay, Cashfree, PayU, bank PSPs…) translate
 * their response codes into these kinds; the router and scheduler only ever see these.
 */

export type TechnicalDeclineCode = 'TIMEOUT' | 'BANK_UNAVAILABLE' | 'SWITCH_ERROR' | 'PSP_ERROR';
export type BusinessDeclineCode =
  | 'INSUFFICIENT_FUNDS'
  | 'WRONG_PIN'
  | 'MANDATE_REVOKED'
  | 'LIMIT_EXCEEDED'
  | 'OTHER';

export type PspResult =
  | { kind: 'SUCCESS'; pspTxnId: string }
  /** Accepted but outcome not yet known — must not be retried. */
  | { kind: 'PENDING' }
  /** Infrastructure failure (bank/switch/PSP). Safe to retry/fail over after a status check. */
  | { kind: 'TECHNICAL_DECLINE'; code: TechnicalDeclineCode }
  /** Customer-side failure. Never retried. */
  | { kind: 'BUSINESS_DECLINE'; code: BusinessDeclineCode }
  /** Status lookup: the PSP has no record of this txnRef. */
  | { kind: 'NOT_FOUND' };

export interface PreDebitNoticeRequest {
  noticeRef: string;
  mandateRef: string;
  amountPaise: number;
  /** IST date (YYYY-MM-DD) the debit will execute on. */
  executionDate: string;
}

export type NoticeResult = { ok: true } | { ok: false; reason: string };

export interface PspAdapter {
  readonly id: string;
  sendPreDebitNotice(req: PreDebitNoticeRequest): Promise<NoticeResult>;
  executeMandate(req: { txnRef: string; mandateRef: string; amountPaise: number }): Promise<PspResult>;
  collect(req: { txnRef: string; payerVpa: string; amountPaise: number }): Promise<PspResult>;
  status(txnRef: string): Promise<PspResult>;
}

export function isTerminal(r: PspResult): boolean {
  return r.kind === 'SUCCESS' || r.kind === 'BUSINESS_DECLINE';
}
