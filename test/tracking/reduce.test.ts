import { describe, expect, it } from 'vitest';
import { DEFAULT_POLLING } from '../../src/config/polling.js';
import { reduce, type ReduceInput } from '../../src/tracking/reduce.js';
import { UNKNOWN_FACTS } from '../../src/tracking/types.js';
import type { TransactionInquiry } from '../../src/psp/types.js';

const start = new Date('2026-10-15T08:00:00Z');
const at = (s: number) => new Date(start.getTime() + s * 1000);
const input = (over: Partial<ReduceInput>): ReduceInput => ({
  subjectType: 'COLLECT',
  domainState: 'PENDING',
  facts: UNKNOWN_FACTS,
  verificationStatus: 'IN_PROGRESS',
  verificationStartedAt: start,
  inquiry: { found: false },
  now: at(5),
  cfg: DEFAULT_POLLING,
  ...over,
});
const found = (over: Partial<Extract<TransactionInquiry, { found: true }>>): TransactionInquiry => ({
  found: true,
  outcome: 'PENDING',
  customerDebit: 'UNKNOWN',
  capture: 'UNKNOWN',
  reversal: { status: 'NONE' },
  upiRrn: '612345678901',
  ...over,
});
const types = (o: ReturnType<typeof reduce>) => o.events.map((e) => e.type);

describe('reduce', () => {
  it('keeps watching a pending payment and schedules the next check', () => {
    const o = reduce(input({ inquiry: found({}) }));
    expect(o.verificationStatus).toBe('IN_PROGRESS');
    expect(o.nextCheckAt).toEqual(at(15));
    expect(o.domainOutcome).toBeNull();
    expect(types(o)).toEqual(['STATUS_CHECKED', 'RRN_RETRIEVED']);
    expect(o.facts.upiRrn).toBe('612345678901');
  });

  it('resolves a pending collect that the PSP reports captured', () => {
    const o = reduce(input({ inquiry: found({ outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED' }) }));
    expect(o.domainOutcome).toEqual({ to: 'SUCCEEDED' });
    expect(o.verificationStatus).toBe('RESOLVED');
    expect(o.nextCheckAt).toBeNull();
    expect(types(o)).toEqual(['STATUS_CHECKED', 'RRN_RETRIEVED', 'CUSTOMER_DEBIT_DETECTED', 'CAPTURE_CONFIRMED', 'VERIFICATION_RESOLVED']);
  });

  it('fails a pending collect the PSP reports failed, with the internal code kept internal', () => {
    const o = reduce(input({ inquiry: found({ outcome: 'FAILED', customerDebit: 'NOT_DEBITED', capture: 'NOT_CAPTURED', failureCode: 'U30' }) }));
    expect(o.domainOutcome).toEqual({ to: 'FAILED', code: 'U30' });
    expect(o.verificationStatus).toBe('RESOLVED');
  });

  it('tracks a failed-but-debited collect through auto-reversal', () => {
    const debited = reduce(input({ domainState: 'FAILED', inquiry: found({ outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED' }) }));
    expect(debited.verificationStatus).toBe('IN_PROGRESS');
    expect(debited.domainOutcome).toBeNull();
    expect(types(debited)).toContain('CUSTOMER_DEBIT_DETECTED');

    const initiated = reduce(input({
      domainState: 'FAILED', facts: debited.facts, now: at(60),
      inquiry: found({ outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'INITIATED', initiatedAt: at(50) } }),
    }));
    expect(initiated.facts.reversalStatus).toBe('INITIATED');
    expect(initiated.facts.reversalInitiatedAt).toEqual(at(50));
    expect(types(initiated)).toEqual(['STATUS_CHECKED', 'REVERSAL_INITIATED']);

    const completed = reduce(input({
      domainState: 'FAILED', facts: initiated.facts, now: at(3600),
      inquiry: found({ outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'COMPLETED' } }),
    }));
    expect(completed.facts.reversalStatus).toBe('COMPLETED');
    expect(completed.facts.reversalInitiatedAt).toEqual(at(50));
    expect(completed.facts.reversalCompletedAt).toEqual(at(3600)); // PSP gave no time → observed time
    expect(completed.verificationStatus).toBe('RESOLVED');
  });

  it('emits both reversal events if the PSP jumps straight to completed', () => {
    const o = reduce(input({ domainState: 'FAILED', inquiry: found({ outcome: 'FAILED', customerDebit: 'DEBITED', reversal: { status: 'COMPLETED' } }) }));
    expect(types(o)).toEqual(expect.arrayContaining(['REVERSAL_INITIATED', 'REVERSAL_COMPLETED']));
    expect(o.facts.reversalInitiatedAt).toEqual(o.facts.reversalCompletedAt);
  });

  it('never moves a reversal backwards', () => {
    const facts = { ...UNKNOWN_FACTS, customerDebit: 'DEBITED' as const, reversalStatus: 'COMPLETED' as const, reversalInitiatedAt: at(1), reversalCompletedAt: at(2) };
    const o = reduce(input({ domainState: 'FAILED', facts, inquiry: found({ outcome: 'FAILED', customerDebit: 'DEBITED', reversal: { status: 'INITIATED' } }) }));
    expect(o.facts.reversalStatus).toBe('COMPLETED');
  });

  it('does not overwrite known facts with UNKNOWN', () => {
    const facts = { ...UNKNOWN_FACTS, customerDebit: 'DEBITED' as const };
    const o = reduce(input({ domainState: 'FAILED', facts, inquiry: found({ outcome: 'FAILED' }) }));
    expect(o.facts.customerDebit).toBe('DEBITED');
  });

  it('treats a failed collect the PSP has no record of as not debited', () => {
    const o = reduce(input({ domainState: 'FAILED', inquiry: { found: false } }));
    expect(o.facts.customerDebit).toBe('NOT_DEBITED');
    expect(o.verificationStatus).toBe('RESOLVED');
  });

  it('keeps watching a pending payment the PSP has no record of yet', () => {
    const o = reduce(input({ inquiry: { found: false } }));
    expect(o.verificationStatus).toBe('IN_PROGRESS');
    expect(o.facts.customerDebit).toBe('UNKNOWN');
  });

  it('flags a late capture as a mismatch without flipping the failed payment', () => {
    const o = reduce(input({ domainState: 'FAILED', inquiry: found({ outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED' }) }));
    expect(o.mismatch).toBe(true);
    expect(o.domainOutcome).toBeNull();
    expect(o.verificationStatus).toBe('RESOLVED');
  });

  it('never changes AutoPay domain state (the Phase 1 worker owns it)', () => {
    const o = reduce(input({ subjectType: 'AUTOPAY', inquiry: found({ outcome: 'SUCCESS', capture: 'CAPTURED', customerDebit: 'DEBITED' }) }));
    expect(o.domainOutcome).toBeNull();
  });

  it('moves to manual investigation when the budget is exhausted', () => {
    const o = reduce(input({ now: at(48 * 3600), inquiry: found({}) }));
    expect(o.verificationStatus).toBe('NEEDS_MANUAL_INVESTIGATION');
    expect(o.nextCheckAt).toBeNull();
    expect(types(o)).toContain('VERIFICATION_EXHAUSTED');
  });

  it('stays in manual investigation on a non-terminal manual recheck, without re-emitting exhaustion', () => {
    const o = reduce(input({ verificationStatus: 'NEEDS_MANUAL_INVESTIGATION', now: at(50 * 3600), inquiry: found({}) }));
    expect(o.verificationStatus).toBe('NEEDS_MANUAL_INVESTIGATION');
    expect(types(o)).not.toContain('VERIFICATION_EXHAUSTED');
  });

  it('records an enquiry error as a check and keeps the schedule', () => {
    const o = reduce(input({ inquiry: { error: 'timeout' } }));
    expect(o.verificationStatus).toBe('IN_PROGRESS');
    expect(o.events).toEqual([{ type: 'STATUS_CHECKED', data: { result: 'ERROR', error: 'timeout' } }]);
  });

  it('emits nothing but the check when facts are unchanged', () => {
    const first = reduce(input({ inquiry: found({}) }));
    const second = reduce(input({ facts: first.facts, now: at(15), inquiry: found({}) }));
    expect(types(second)).toEqual(['STATUS_CHECKED']);
  });
});
