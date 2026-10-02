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
  /** upiRrn: the 12-digit UPI reference, when the PSP returns it inline. */
  | { kind: 'SUCCESS'; pspTxnId: string; upiRrn?: string }
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

export type CustomerDebit = 'DEBITED' | 'NOT_DEBITED' | 'UNKNOWN';
export type Capture = 'CAPTURED' | 'NOT_CAPTURED' | 'UNKNOWN';
export type ReversalStatus = 'NONE' | 'INITIATED' | 'COMPLETED' | 'UNKNOWN';

/**
 * Full money-movement picture of one transaction, normalized from the PSP's transaction
 * enquiry / UDIR status APIs. `capture` means PSP-confirmed capture for the merchant —
 * never bank settlement, which we don't ingest.
 */
export type TransactionInquiry =
  | { found: false }
  | {
      found: true;
      outcome: 'SUCCESS' | 'PENDING' | 'FAILED';
      customerDebit: CustomerDebit;
      capture: Capture;
      reversal: { status: ReversalStatus; initiatedAt?: Date; completedAt?: Date };
      upiRrn?: string;
      npciTxnId?: string;
      /** PSP-specific code. Internal only — never surfaced to merchants or customers. */
      failureCode?: string;
    };

export type ComplaintReason = 'DEBITED_NOT_CREDITED' | 'STATUS_UNKNOWN';
export type ComplaintStatus = 'SUBMITTED' | 'IN_PROGRESS' | 'RESOLVED_REVERSED' | 'RESOLVED_NO_REVERSAL' | 'REJECTED';

export interface ComplaintRequest {
  txnRef: string;
  upiRrn?: string;
  amountPaise: number;
  reason: ComplaintReason;
  /** Same key → same complaint; adapters must not raise duplicates. */
  idempotencyKey: string;
}

export type ComplaintResult =
  | { ok: true; pspComplaintRef: string; status: ComplaintStatus }
  | { ok: false; reason: string; retryable: boolean };

export type ComplaintStatusResult = { ok: true; status: ComplaintStatus; updatedAt: Date } | { ok: false; reason: string };

export interface PspAdapter {
  readonly id: string;
  /** MOCK adapters never reach a real PSP/NPCI; the UI must say so. */
  readonly mode: 'MOCK' | 'LIVE';
  sendPreDebitNotice(req: PreDebitNoticeRequest): Promise<NoticeResult>;
  executeMandate(req: { txnRef: string; mandateRef: string; amountPaise: number }): Promise<PspResult>;
  collect(req: { txnRef: string; payerVpa: string; amountPaise: number }): Promise<PspResult>;
  status(txnRef: string): Promise<PspResult>;
  /** Transaction enquiry incl. debit/capture/reversal facts. Throws on transport failure. */
  inquire(txnRef: string): Promise<TransactionInquiry>;
  /** Raise a UDIR complaint for a transaction via the PSP. */
  raiseComplaint(req: ComplaintRequest): Promise<ComplaintResult>;
  complaintStatus(pspComplaintRef: string): Promise<ComplaintStatusResult>;
}

export function isTerminal(r: PspResult): boolean {
  return r.kind === 'SUCCESS' || r.kind === 'BUSINESS_DECLINE';
}
