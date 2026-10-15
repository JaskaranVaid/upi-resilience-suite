import type { PollingConfig } from '../config/polling.js';
import type { ReversalStatus, TransactionInquiry } from '../psp/types.js';
import { nextCheckAt } from './schedule.js';
import type { DomainState, MoneyFacts, NewEvent, SubjectType, VerificationStatus } from './types.js';

export interface ReduceInput {
  subjectType: SubjectType;
  domainState: DomainState;
  facts: MoneyFacts;
  verificationStatus: VerificationStatus;
  verificationStartedAt: Date | null;
  /** The enquiry result, or the transport error message if the enquiry failed. */
  inquiry: TransactionInquiry | { error: string };
  /** Until when a failed attempt is not final, because the customer may retry on the same order. */
  retryOpenUntil?: Date | null;
  now: Date;
  cfg: PollingConfig;
}

export type DomainOutcome = { to: 'SUCCEEDED' } | { to: 'FAILED'; code: string };

export interface ReduceOutput {
  facts: MoneyFacts;
  verificationStatus: VerificationStatus;
  nextCheckAt: Date | null;
  events: NewEvent[];
  /** Transition to apply to a PENDING collect. AutoPay state stays with the Phase 1 worker. */
  domainOutcome: DomainOutcome | null;
  /** We reported failure but the PSP says the money was captured. */
  mismatch: boolean;
}

const REVERSAL_ORDER: Record<ReversalStatus, number> = { UNKNOWN: 0, NONE: 0, INITIATED: 1, COMPLETED: 2 };

/**
 * Apply one status check to a tracked payment. Pure and deterministic: given the same
 * input it always produces the same facts, schedule, events and outcome.
 */
export function reduce(i: ReduceInput): ReduceOutput {
  const events: NewEvent[] = [];
  const prev = i.facts;
  let facts = { ...prev };
  let domainOutcome: DomainOutcome | null = null;

  if ('error' in i.inquiry) {
    events.push({ type: 'STATUS_CHECKED', data: { result: 'ERROR', error: i.inquiry.error } });
  } else if (!i.inquiry.found) {
    events.push({ type: 'STATUS_CHECKED', data: { result: 'NOT_FOUND' } });
    // A failed payment the PSP has no record of never reached the customer's bank.
    if (i.domainState === 'FAILED') {
      facts.customerDebit = facts.customerDebit === 'UNKNOWN' ? 'NOT_DEBITED' : facts.customerDebit;
      facts.capture = facts.capture === 'UNKNOWN' ? 'NOT_CAPTURED' : facts.capture;
    }
  } else {
    const q = i.inquiry;
    events.push({ type: 'STATUS_CHECKED', data: { result: 'FOUND', outcome: q.outcome, ...(q.failureCode ? { failureCode: q.failureCode } : {}) } });
    facts = mergeFacts(prev, q, i.now);
    if (i.subjectType === 'COLLECT' && i.domainState === 'PENDING') {
      if (q.outcome === 'SUCCESS') domainOutcome = { to: 'SUCCEEDED' };
      else if (q.outcome === 'FAILED' && !(i.retryOpenUntil && i.now < i.retryOpenUntil)) {
        domainOutcome = { to: 'FAILED', code: q.failureCode ?? 'FAILED' };
      }
    }
  }

  if (!prev.upiRrn && facts.upiRrn) events.push({ type: 'RRN_RETRIEVED' });
  if (prev.customerDebit !== 'DEBITED' && facts.customerDebit === 'DEBITED') events.push({ type: 'CUSTOMER_DEBIT_DETECTED' });
  if (prev.capture !== 'CAPTURED' && facts.capture === 'CAPTURED') events.push({ type: 'CAPTURE_CONFIRMED' });
  if (REVERSAL_ORDER[prev.reversalStatus] < 1 && REVERSAL_ORDER[facts.reversalStatus] >= 1) events.push({ type: 'REVERSAL_INITIATED' });
  if (prev.reversalStatus !== 'COMPLETED' && facts.reversalStatus === 'COMPLETED') events.push({ type: 'REVERSAL_COMPLETED' });

  const domain: DomainState = domainOutcome?.to ?? i.domainState;
  const mismatch = domain === 'FAILED' && facts.capture === 'CAPTURED';
  const terminal =
    domain === 'SUCCEEDED' ||
    mismatch ||
    facts.reversalStatus === 'COMPLETED' ||
    (domain === 'FAILED' && facts.customerDebit === 'NOT_DEBITED');

  let verificationStatus: VerificationStatus;
  let next: Date | null = null;
  const watching = i.verificationStatus === 'IN_PROGRESS' || i.verificationStatus === 'NEEDS_MANUAL_INVESTIGATION';
  if (!watching) {
    // A manual recheck refreshes the facts but never starts a watch on a settled payment.
    verificationStatus = i.verificationStatus;
  } else if (terminal) {
    verificationStatus = 'RESOLVED';
    events.push({ type: 'VERIFICATION_RESOLVED' });
  } else if (i.verificationStatus === 'NEEDS_MANUAL_INVESTIGATION') {
    verificationStatus = 'NEEDS_MANUAL_INVESTIGATION';
  } else {
    next = nextCheckAt(i.verificationStartedAt ?? i.now, i.now, i.cfg);
    verificationStatus = next ? 'IN_PROGRESS' : 'NEEDS_MANUAL_INVESTIGATION';
    if (!next) events.push({ type: 'VERIFICATION_EXHAUSTED' });
  }

  return { facts, verificationStatus, nextCheckAt: next, events, domainOutcome, mismatch };
}

function mergeFacts(prev: MoneyFacts, q: Extract<TransactionInquiry, { found: true }>, now: Date): MoneyFacts {
  const reversalStatus = REVERSAL_ORDER[q.reversal.status] > REVERSAL_ORDER[prev.reversalStatus] ? q.reversal.status : prev.reversalStatus;
  // The PSP's timestamps win; otherwise use when we first observed the change.
  const completedAt = reversalStatus === 'COMPLETED' ? (prev.reversalCompletedAt ?? q.reversal.completedAt ?? now) : prev.reversalCompletedAt;
  const initiatedAt =
    REVERSAL_ORDER[reversalStatus] >= 1 ? (prev.reversalInitiatedAt ?? q.reversal.initiatedAt ?? completedAt ?? now) : prev.reversalInitiatedAt;
  return {
    customerDebit: q.customerDebit === 'UNKNOWN' ? prev.customerDebit : q.customerDebit,
    capture: q.capture === 'UNKNOWN' ? prev.capture : q.capture,
    reversalStatus,
    reversalInitiatedAt: initiatedAt,
    reversalCompletedAt: completedAt,
    upiRrn: prev.upiRrn ?? q.upiRrn ?? null,
    npciTxnId: prev.npciTxnId ?? q.npciTxnId ?? null,
  };
}
