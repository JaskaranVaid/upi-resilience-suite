import { describe, expect, it } from 'vitest';
import { DEFAULT_POLLING } from '../../src/config/polling.js';
import { caseResolution, caseStatus, customerStatus, merchantStatus, type CaseInput, type StatusInput } from '../../src/tracking/derive.js';

const now = new Date('2026-10-15T08:10:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const base: StatusInput = {
  subjectType: 'COLLECT',
  domainState: 'PENDING',
  awaitingExecution: false,
  pendingSince: ago(1000),
  now,
  tracking: null,
};
const trk = (over: Partial<NonNullable<StatusInput['tracking']>>) => ({
  customerDebit: 'UNKNOWN' as const,
  capture: 'UNKNOWN' as const,
  reversalStatus: 'NONE' as const,
  verificationStatus: 'IN_PROGRESS' as const,
  ...over,
});
const ms = (i: Partial<StatusInput>) => merchantStatus({ ...base, ...i }, DEFAULT_POLLING).code;

describe('merchantStatus', () => {
  it.each([
    ['fresh pending collect', {}, 'PROCESSING'],
    ['pending past 45s', { pendingSince: ago(45_000) }, 'VERIFYING'],
    ['autopay waiting for its slot', { subjectType: 'AUTOPAY', awaitingExecution: true, pendingSince: ago(3_600_000) }, 'SCHEDULED'],
    ['succeeded', { domainState: 'SUCCEEDED', tracking: trk({ capture: 'CAPTURED', customerDebit: 'DEBITED', verificationStatus: 'NOT_REQUIRED' }) }, 'SUCCEEDED'],
    ['failed, no tracking', { domainState: 'FAILED' }, 'FAILED'],
    ['failed, debit not yet known while verifying', { domainState: 'FAILED', tracking: trk({}) }, 'VERIFYING'],
    ['failed, confirmed not debited', { domainState: 'FAILED', tracking: trk({ customerDebit: 'NOT_DEBITED', verificationStatus: 'RESOLVED' }) }, 'FAILED'],
    ['debited not captured', { domainState: 'FAILED', tracking: trk({ customerDebit: 'DEBITED', capture: 'NOT_CAPTURED' }) }, 'DEBITED_NOT_CAPTURED'],
    ['reversal initiated', { domainState: 'FAILED', tracking: trk({ customerDebit: 'DEBITED', reversalStatus: 'INITIATED' }) }, 'REVERSAL_IN_PROGRESS'],
    ['reversal completed', { domainState: 'FAILED', tracking: trk({ customerDebit: 'DEBITED', reversalStatus: 'COMPLETED', verificationStatus: 'RESOLVED' }) }, 'REVERSED'],
    ['budget exhausted', { domainState: 'PENDING', tracking: trk({ verificationStatus: 'NEEDS_MANUAL_INVESTIGATION' }) }, 'NEEDS_INVESTIGATION'],
    ['late capture after failure', { domainState: 'FAILED', tracking: trk({ customerDebit: 'DEBITED', capture: 'CAPTURED', verificationStatus: 'RESOLVED' }) }, 'CAPTURED_AFTER_FAILURE'],
  ] as const)('%s → %s', (_n, input, expected) => {
    expect(ms(input as Partial<StatusInput>)).toBe(expected);
  });

  it('labels capture as PSP-confirmed, never settlement', () => {
    const s = merchantStatus({ ...base, domainState: 'SUCCEEDED' }, DEFAULT_POLLING);
    expect(s.label).toMatch(/captured/i);
    expect(s.label).not.toMatch(/settle/i);
  });
});

describe('customerStatus', () => {
  it.each([
    ['PROCESSING', 'UNKNOWN', 'processing'],
    ['VERIFYING', 'UNKNOWN', 'verification_in_progress'],
    ['NEEDS_INVESTIGATION', 'UNKNOWN', 'verification_in_progress'],
    ['DEBITED_NOT_CAPTURED', 'DEBITED', 'verification_in_progress'],
    ['CAPTURED_AFTER_FAILURE', 'DEBITED', 'verification_in_progress'],
    ['REVERSAL_IN_PROGRESS', 'DEBITED', 'refund_processing'],
    ['REVERSED', 'DEBITED', 'refunded'],
    ['SUCCEEDED', 'DEBITED', 'success'],
    ['FAILED', 'NOT_DEBITED', 'failed'],
    ['FAILED', 'UNKNOWN', 'failed'],
  ] as const)('%s (debit %s) → %s', (code, debit, expected) => {
    expect(customerStatus(code, debit).status).toBe(expected);
  });

  it('tells customers not to pay again while verifying', () => {
    expect(customerStatus('VERIFYING', 'UNKNOWN').message).toMatch(/don't make another payment/);
  });

  it('only says "not charged" when we know the customer was not debited', () => {
    expect(customerStatus('FAILED', 'NOT_DEBITED').message).toMatch(/not been charged/);
    expect(customerStatus('FAILED', 'UNKNOWN').message).not.toMatch(/not been charged/);
  });
});

describe('caseStatus / caseResolution', () => {
  const c: CaseInput = {
    reason: 'DEBITED_NOT_CAPTURED',
    domainState: 'FAILED',
    customerDebit: 'DEBITED',
    capture: 'NOT_CAPTURED',
    reversalStatus: 'NONE',
    verificationStatus: 'IN_PROGRESS',
    complaintStatus: null,
    closedByMerchant: false,
  };

  it.each([
    ['debited, still watching', {}, 'REVERSAL_PENDING'],
    ['reversal initiated, watching', { reversalStatus: 'INITIATED' }, 'REVERSAL_PENDING'],
    ['reversal completed', { reversalStatus: 'COMPLETED', verificationStatus: 'RESOLVED' }, 'RESOLVED'],
    ['debited, budget exhausted, no reversal', { verificationStatus: 'NEEDS_MANUAL_INVESTIGATION' }, 'NEEDS_ACTION'],
    ['complaint in progress', { verificationStatus: 'IN_PROGRESS', complaintStatus: 'IN_PROGRESS' }, 'INVESTIGATING'],
    ['complaint rejected', { complaintStatus: 'REJECTED' }, 'NEEDS_ACTION'],
    ['complaint resolved', { complaintStatus: 'RESOLVED_REVERSED' }, 'RESOLVED'],
    ['outcome still pending', { domainState: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reason: 'VERIFICATION_EXHAUSTED', verificationStatus: 'IN_PROGRESS' }, 'VERIFICATION_PENDING'],
    ['exhausted while pending', { domainState: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reason: 'VERIFICATION_EXHAUSTED', verificationStatus: 'NEEDS_MANUAL_INVESTIGATION' }, 'NEEDS_ACTION'],
    ['late capture mismatch', { reason: 'STATUS_MISMATCH', capture: 'CAPTURED', verificationStatus: 'RESOLVED' }, 'NEEDS_ACTION'],
    ['mismatch closed by merchant', { reason: 'STATUS_MISMATCH', capture: 'CAPTURED', closedByMerchant: true }, 'RESOLVED'],
    ['turned out not debited', { customerDebit: 'NOT_DEBITED', verificationStatus: 'RESOLVED' }, 'RESOLVED'],
    ['captured after all (pending → success)', { domainState: 'SUCCEEDED', capture: 'CAPTURED', reason: 'VERIFICATION_EXHAUSTED' }, 'RESOLVED'],
  ] as const)('%s → %s', (_n, over, expected) => {
    expect(caseStatus({ ...c, ...(over as Partial<CaseInput>) })).toBe(expected);
  });

  it('names the resolution', () => {
    expect(caseResolution({ ...c, reversalStatus: 'COMPLETED' })).toBe('REVERSED_TO_CUSTOMER');
    expect(caseResolution({ ...c, customerDebit: 'NOT_DEBITED' })).toBe('NOT_DEBITED');
    expect(caseResolution({ ...c, complaintStatus: 'RESOLVED_NO_REVERSAL' })).toBe('COMPLAINT_RESOLVED');
    expect(caseResolution({ ...c, domainState: 'SUCCEEDED', capture: 'CAPTURED' })).toBe('CAPTURED');
    expect(caseResolution({ ...c, reason: 'STATUS_MISMATCH', capture: 'CAPTURED', closedByMerchant: true })).toBe('CLOSED_BY_MERCHANT');
    expect(caseResolution(c)).toBeNull();
  });
});
