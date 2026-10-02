import type { Capture, ComplaintStatus, CustomerDebit, ReversalStatus } from '../psp/types.js';

export type SubjectType = 'COLLECT' | 'AUTOPAY';

/** Outcome of the underlying Phase 1–2 record, normalized across collects and debits. */
export type DomainState = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type VerificationStatus = 'NOT_REQUIRED' | 'IN_PROGRESS' | 'RESOLVED' | 'NEEDS_MANUAL_INVESTIGATION';

export interface MoneyFacts {
  customerDebit: CustomerDebit;
  capture: Capture;
  reversalStatus: ReversalStatus;
  reversalInitiatedAt: Date | null;
  reversalCompletedAt: Date | null;
  upiRrn: string | null;
  npciTxnId: string | null;
}

export const UNKNOWN_FACTS: MoneyFacts = {
  customerDebit: 'UNKNOWN',
  capture: 'UNKNOWN',
  reversalStatus: 'NONE',
  reversalInitiatedAt: null,
  reversalCompletedAt: null,
  upiRrn: null,
  npciTxnId: null,
};

export type CaseReason = 'DEBITED_NOT_CAPTURED' | 'VERIFICATION_EXHAUSTED' | 'STATUS_MISMATCH' | 'MERCHANT_RAISED';
export type CaseStatus = 'NEEDS_ACTION' | 'INVESTIGATING' | 'VERIFICATION_PENDING' | 'REVERSAL_PENDING' | 'RESOLVED';
export type CaseResolution = 'REVERSED_TO_CUSTOMER' | 'CAPTURED' | 'NOT_DEBITED' | 'COMPLAINT_RESOLVED' | 'CLOSED_BY_MERCHANT';

export type { ComplaintStatus };

export type EventType =
  | 'PAYMENT_CREATED'
  | 'PAYMENT_SUBMITTED'
  | 'PAYMENT_STATE_CHANGED'
  | 'VERIFICATION_STARTED'
  | 'STATUS_CHECKED'
  | 'RRN_RETRIEVED'
  | 'CUSTOMER_DEBIT_DETECTED'
  | 'CAPTURE_CONFIRMED'
  | 'REVERSAL_INITIATED'
  | 'REVERSAL_COMPLETED'
  | 'VERIFICATION_RESOLVED'
  | 'VERIFICATION_EXHAUSTED'
  | 'CASE_OPENED'
  | 'CASE_STATUS_CHANGED'
  | 'CASE_RESOLVED'
  | 'UDIR_COMPLAINT_RAISED'
  | 'UDIR_COMPLAINT_UPDATED'
  | 'RECHECK_REQUESTED'
  | 'NOTE_ADDED'
  | 'PAYMENT_VIEWED'
  | 'CASE_VIEWED'
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED';

export interface NewEvent {
  type: EventType;
  /** Internal detail for audit. Never returned to UIs as-is. */
  data?: Record<string, unknown>;
}
