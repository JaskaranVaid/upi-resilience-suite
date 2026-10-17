import { AUTOPAY_PEAK_RULE_FROM, getRuleSet } from '../config/rules.js';
import type { FailureKind, ShadowOutcome, WouldRefuse } from '../db/schema.js';
import { isRestricted } from '../rules/windows.js';

/**
 * What Merchantflo would have changed about one execution of the merchant's own system. Every
 * reported execution lands in exactly one class; only PEAK_RESCUE (certain) and RETRY_RECOVERABLE
 * (potential, an upper bound) carry value.
 */
export type ShadowClass =
  | 'PEAK_RESCUE'
  | 'RETRY_RECOVERABLE'
  | 'PEAK_RISK'
  | 'WOULD_REFUSE'
  | 'BUSINESS_DECLINE'
  | 'UNCLASSIFIED_FAILURE'
  | 'NO_CHANGE';

export type ShadowValue = 'CERTAIN' | 'POTENTIAL' | 'NONE';

export const SHADOW_CLASSES: Record<ShadowClass, { label: string; value: ShadowValue; methodNote: string }> = {
  PEAK_RESCUE: {
    label: 'Failed in an NPCI restricted window — would have run off-peak',
    value: 'CERTAIN',
    methodNote:
      'Executions your system ran inside an NPCI AutoPay peak or blackout window (in force since 1 Aug 2025) that failed for a technical reason. Merchantflo never executes in those windows, so these are counted at full amount, the same way as live peak-hour protection.',
  },
  RETRY_RECOVERABLE: {
    label: 'Technical failure outside restricted windows — recoverable by a safe retry',
    value: 'POTENTIAL',
    methodNote:
      'Technical failures (bank, switch or PSP) outside the restricted windows. Merchantflo status-checks such a failure and retries it safely, so some would have been captured: the full amount is an upper bound, never added to the certain value.',
  },
  PEAK_RISK: {
    label: 'Succeeded inside a restricted window — compliance exposure',
    value: 'NONE',
    methodNote: 'Executions that succeeded although they ran inside an NPCI restricted window. No value is claimed; they are executions NPCI rules do not allow, which Merchantflo would have moved off-peak.',
  },
  WOULD_REFUSE: {
    label: 'Would have been refused at intake',
    value: 'NONE',
    methodNote:
      'Debits Merchantflo would not run as silent AutoPay: above the no-AFA limit (the customer must authenticate them), above the mandate limit, or on an inactive mandate. No value is claimed.',
  },
  BUSINESS_DECLINE: {
    label: 'Declined on the customer side',
    value: 'NONE',
    methodNote: 'Failures you reported as BUSINESS (e.g. insufficient funds, revoked mandate). Retrying cannot fix them and Merchantflo would not have.',
  },
  UNCLASSIFIED_FAILURE: {
    label: 'Failed, cause not reported',
    value: 'NONE',
    methodNote: 'Failures reported without a failureKind (or as UNKNOWN). They are never credited: report TECHNICAL or BUSINESS for these to be assessed.',
  },
  NO_CHANGE: {
    label: 'Succeeded off-peak — nothing to change',
    value: 'NONE',
    methodNote: 'Executions that succeeded outside the restricted windows.',
  },
};

/** Inside an NPCI AutoPay restricted window (peak or blackout), on a date the rule applied. */
export function inRestrictedWindow(at: Date): boolean {
  return at >= AUTOPAY_PEAK_RULE_FROM && isRestricted(at, getRuleSet(at).windows);
}

export function classifyShadow(row: { outcome: ShadowOutcome; executedAt: Date; failureKind: FailureKind | null; wouldRefuse: WouldRefuse | null }): ShadowClass {
  if (row.wouldRefuse) return 'WOULD_REFUSE';
  const restricted = inRestrictedWindow(row.executedAt);
  if (row.outcome === 'SUCCEEDED') return restricted ? 'PEAK_RISK' : 'NO_CHANGE';
  if (row.failureKind === 'BUSINESS') return 'BUSINESS_DECLINE';
  if (row.failureKind !== 'TECHNICAL') return 'UNCLASSIFIED_FAILURE';
  return restricted ? 'PEAK_RESCUE' : 'RETRY_RECOVERABLE';
}
