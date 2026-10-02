import type { PollingConfig } from '../config/polling.js';
import type { Capture, ComplaintStatus, CustomerDebit, ReversalStatus } from '../psp/types.js';
import type { CaseReason, CaseResolution, CaseStatus, DomainState, SubjectType, VerificationStatus } from './types.js';

/*
 * The single place that turns internal state into what merchants and customers see.
 * The dashboard and the public endpoint render these values; they never derive their own.
 */

export type MerchantStatus =
  | 'SCHEDULED'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEBITED_NOT_CAPTURED'
  | 'CAPTURED_AFTER_FAILURE'
  | 'REVERSAL_IN_PROGRESS'
  | 'REVERSED'
  | 'NEEDS_INVESTIGATION';

export const MERCHANT_STATUS_LABELS: Record<MerchantStatus, string> = {
  SCHEDULED: 'Scheduled',
  PROCESSING: 'Processing',
  VERIFYING: 'Payment verification in progress',
  SUCCEEDED: 'Successful — captured (PSP-confirmed)',
  FAILED: 'Failed',
  DEBITED_NOT_CAPTURED: 'Customer debited, payment not captured',
  CAPTURED_AFTER_FAILURE: 'Captured after failure was reported — action needed',
  REVERSAL_IN_PROGRESS: 'Auto-reversal to customer in progress',
  REVERSED: 'Reversed to customer',
  NEEDS_INVESTIGATION: 'Needs manual investigation',
};

export interface StatusInput {
  subjectType: SubjectType;
  domainState: DomainState;
  /** AutoPay debit still waiting for its execution slot. */
  awaitingExecution: boolean;
  /** When the payment was submitted to the PSP (age drives the "verifying" wording). */
  pendingSince: Date;
  now: Date;
  tracking: {
    customerDebit: CustomerDebit;
    capture: Capture;
    reversalStatus: ReversalStatus;
    verificationStatus: VerificationStatus;
  } | null;
}

export function merchantStatus(i: StatusInput, cfg: PollingConfig): { code: MerchantStatus; label: string } {
  const code = merchantStatusCode(i, cfg);
  return { code, label: MERCHANT_STATUS_LABELS[code] };
}

function merchantStatusCode(i: StatusInput, cfg: PollingConfig): MerchantStatus {
  const t = i.tracking;
  if (t?.verificationStatus === 'NEEDS_MANUAL_INVESTIGATION') return 'NEEDS_INVESTIGATION';
  if (t?.reversalStatus === 'COMPLETED') return 'REVERSED';
  if (t?.reversalStatus === 'INITIATED') return 'REVERSAL_IN_PROGRESS';
  if (i.domainState === 'FAILED' && t?.capture === 'CAPTURED') return 'CAPTURED_AFTER_FAILURE';
  if (i.domainState !== 'PENDING' && t?.customerDebit === 'DEBITED' && t.capture !== 'CAPTURED') return 'DEBITED_NOT_CAPTURED';
  if (i.domainState === 'SUCCEEDED') return 'SUCCEEDED';
  if (i.domainState === 'PENDING' && i.awaitingExecution) return 'SCHEDULED';
  const pendingLong = i.domainState === 'PENDING' && i.now.getTime() - i.pendingSince.getTime() >= cfg.verifyingAfterMs;
  const failedUnderVerification = i.domainState === 'FAILED' && t?.verificationStatus === 'IN_PROGRESS' && t.customerDebit === 'UNKNOWN';
  if (pendingLong || failedUnderVerification) return 'VERIFYING';
  if (i.domainState === 'PENDING') return 'PROCESSING';
  return 'FAILED';
}

export type CustomerStatus = 'processing' | 'success' | 'failed' | 'verification_in_progress' | 'refund_processing' | 'refunded';

const VERIFYING_MESSAGE = "We're verifying your payment. Please don't make another payment.";

/** Deliberately coarse: we only tell customers what we have actually observed. */
export function customerStatus(code: MerchantStatus, debit: CustomerDebit): { status: CustomerStatus; message: string } {
  switch (code) {
    case 'SCHEDULED':
    case 'PROCESSING':
      return { status: 'processing', message: 'Processing your payment…' };
    case 'VERIFYING':
    case 'NEEDS_INVESTIGATION':
    case 'DEBITED_NOT_CAPTURED':
    case 'CAPTURED_AFTER_FAILURE':
      return { status: 'verification_in_progress', message: VERIFYING_MESSAGE };
    case 'REVERSAL_IN_PROGRESS':
      return { status: 'refund_processing', message: 'Your bank is reversing this payment to your account.' };
    case 'REVERSED':
      return { status: 'refunded', message: 'The amount has been reversed to your account.' };
    case 'SUCCEEDED':
      return { status: 'success', message: 'Payment successful.' };
    case 'FAILED':
      return {
        status: 'failed',
        message: debit === 'NOT_DEBITED' ? 'Payment failed. You have not been charged.' : 'Payment failed.',
      };
  }
}

export interface CaseInput {
  reason: CaseReason;
  domainState: DomainState;
  customerDebit: CustomerDebit;
  capture: Capture;
  reversalStatus: ReversalStatus;
  verificationStatus: VerificationStatus;
  /** Latest status of the case's UDIR complaint, if one was raised. */
  complaintStatus: ComplaintStatus | null;
  closedByMerchant: boolean;
}

export function caseResolution(c: CaseInput): CaseResolution | null {
  if (c.closedByMerchant) return 'CLOSED_BY_MERCHANT';
  if (c.reversalStatus === 'COMPLETED') return 'REVERSED_TO_CUSTOMER';
  if (c.complaintStatus === 'RESOLVED_REVERSED' || c.complaintStatus === 'RESOLVED_NO_REVERSAL') return 'COMPLAINT_RESOLVED';
  if (c.domainState !== 'PENDING' && c.customerDebit === 'NOT_DEBITED') return 'NOT_DEBITED';
  if (c.capture === 'CAPTURED' && c.reason !== 'STATUS_MISMATCH') return 'CAPTURED';
  return null;
}

/**
 * Dispute Desk bucket. "Needs action" is driven only by the configurable verification
 * budget and observed facts — never by a regulatory deadline (none is confirmed yet).
 */
export function caseStatus(c: CaseInput): CaseStatus {
  if (caseResolution(c)) return 'RESOLVED';
  const debitedNotCaptured = c.customerDebit === 'DEBITED' && c.capture !== 'CAPTURED';
  const complaintActive = c.complaintStatus === 'SUBMITTED' || c.complaintStatus === 'IN_PROGRESS';
  if (
    c.verificationStatus === 'NEEDS_MANUAL_INVESTIGATION' ||
    c.complaintStatus === 'REJECTED' ||
    c.reason === 'STATUS_MISMATCH' ||
    (debitedNotCaptured && c.reversalStatus !== 'INITIATED' && c.verificationStatus !== 'IN_PROGRESS' && !complaintActive)
  ) {
    return 'NEEDS_ACTION';
  }
  if (complaintActive) return 'INVESTIGATING';
  if (debitedNotCaptured) return 'REVERSAL_PENDING';
  return 'VERIFICATION_PENDING';
}
