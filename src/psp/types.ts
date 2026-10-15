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

/** How the customer pays for a one-off payment. */
export const PAYMENT_CHANNELS = ['UPI_COLLECT', 'UPI_INTENT', 'UPI_QR', 'NETBANKING', 'CARD'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

/**
 * What the customer must do to complete a payment, as the PSP returned it. Deeplinks and QR data
 * are passed through unmodified. Card details never reach us: cards use the PSP's own checkout.
 */
export type CustomerAction =
  /** A collect request was sent to this VPA: the customer approves it in their UPI app. */
  | { type: 'UPI_COLLECT'; vpa: string }
  /** Open `url` (upi://pay…) on the customer's phone; `appUrls` target specific apps when given. */
  | { type: 'UPI_INTENT'; url: string; appUrls: Record<string, string> }
  /** Render `qrData` (a upi://pay… string) as a QR code, or show `qrImage` (base64 PNG) when given. */
  | { type: 'UPI_QR'; qrData?: string; qrImage?: string }
  /** Send the customer's browser to `url` (e.g. their bank's netbanking page). */
  | { type: 'REDIRECT'; url: string }
  /** Open the PSP's own checkout (its JS SDK) with these parameters. */
  | { type: 'PSP_CHECKOUT'; provider: string; environment: 'sandbox' | 'production'; params: Record<string, string> };

export type PspResult =
  /** upiRrn: the 12-digit UPI reference, when the PSP returns it inline. */
  | { kind: 'SUCCESS'; pspTxnId: string; upiRrn?: string }
  /** Accepted but outcome not yet known — must not be retried. `action`: what the customer must do. */
  | { kind: 'PENDING'; action?: CustomerAction }
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

export type PspMode = 'MOCK' | 'SANDBOX' | 'LIVE';

/** What a provider can and cannot do; the scheduler, router and UI adapt to it. */
export interface PspCapabilities {
  /** Minimum gap between a successful pre-debit notice and the mandate execution. */
  minNoticeMs: number;
  /** Furthest ahead a pre-debit notice may be sent before its execution date (null = no limit). */
  maxNoticeLeadMs: number | null;
  /** Can raise UDIR complaints on the merchant's behalf via API. */
  udirComplaints: boolean;
  /** Its mandates can be executed through other PSPs (MIC portability). */
  portableMandates: boolean;
  /** Fields a collect request must carry for this provider. */
  collectRequires: Array<'customerPhone'>;
  /** Payment channels this provider can take one-off payments through. */
  channels: PaymentChannel[];
  /** Can execute UPI AutoPay mandates when Merchantflo chooses (notice, then execute). */
  autopay: boolean;
}

/** Identifies what a txnRef belongs to, for providers that need more than the reference. */
export type TxnContext =
  | { kind: 'COLLECT' }
  /** noticeRef: the base payment the pre-debit notice was sent for (our debit id). */
  | { kind: 'MANDATE'; mandateRef: string; noticeRef: string };

export interface ExecuteMandateRequest {
  txnRef: string;
  mandateRef: string;
  amountPaise: number;
  /** The pre-debit notice this execution fulfils (same base payment). */
  noticeRef: string;
}

export interface CollectRequest {
  txnRef: string;
  channel: PaymentChannel;
  /** Required for UPI_COLLECT. */
  payerVpa?: string;
  amountPaise: number;
  customerPhone?: string;
  /** NETBANKING straight to this bank (PSP bank code); otherwise the PSP's checkout lets the customer choose. */
  netbankingBankCode?: string;
  /** The customer's device, which some PSPs require for server-to-server payments. */
  client?: { ip?: string; userAgent?: string };
}

export type WebhookVerification = { ok: true; refs: string[] } | { ok: false; reason: string };

export interface PspAdapter {
  readonly id: string;
  /** MOCK never reaches a real PSP; SANDBOX reaches a PSP's test environment. The UI says which. */
  readonly mode: PspMode;
  readonly capabilities: PspCapabilities;
  sendPreDebitNotice(req: PreDebitNoticeRequest): Promise<NoticeResult>;
  executeMandate(req: ExecuteMandateRequest): Promise<PspResult>;
  collect(req: CollectRequest): Promise<PspResult>;
  status(txnRef: string, ctx: TxnContext): Promise<PspResult>;
  /** Transaction enquiry incl. debit/capture/reversal facts. Throws on transport failure. */
  inquire(txnRef: string, ctx: TxnContext): Promise<TransactionInquiry>;
  /** Raise a UDIR complaint for a transaction via the PSP (when capabilities.udirComplaints). */
  raiseComplaint(req: ComplaintRequest): Promise<ComplaintResult>;
  complaintStatus(pspComplaintRef: string): Promise<ComplaintStatusResult>;
  /**
   * Verify an inbound webhook and extract the references it concerns. Webhooks only ever
   * trigger a status re-check; they never change state by themselves.
   */
  verifyWebhook?(rawBody: string, headers: Record<string, string | string[] | undefined>, now: Date): WebhookVerification;
  /** Confirm the credentials work (a harmless authenticated lookup), before they are saved. */
  checkCredentials?(): Promise<CredentialCheck>;
  /** Whether a mandate exists and can be debited at this PSP. Throws when the lookup fails. */
  mandateStatus?(mandateRef: string): Promise<MandateLookup>;
}

export type MandateLookup = 'ACTIVE' | 'INACTIVE' | 'NOT_FOUND';

export type CredentialCheck = { ok: true } | { ok: false; reason: string; rejected: boolean };

export function isTerminal(r: PspResult): boolean {
  return r.kind === 'SUCCESS' || r.kind === 'BUSINESS_DECLINE';
}
