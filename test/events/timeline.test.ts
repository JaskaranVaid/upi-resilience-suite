import { describe, expect, it } from 'vitest';
import { toTimeline, type EventRow } from '../../src/events/timeline.js';

let n = 0;
const ev = (type: EventRow['type'], data?: Record<string, unknown>, actorId: string | null = null): EventRow => ({
  type,
  data: data ?? null,
  actorType: actorId ? 'DASHBOARD_USER' : 'SYSTEM',
  actorId,
  createdAt: new Date(Date.UTC(2026, 9, 15, 8, 0, n++)),
});
const users = new Map([['usr_1', 'Priya (Support)']]);
const ALLOWED_KEYS = ['at', 'type', 'label', 'detail', 'actor', 'count'];

describe('toTimeline', () => {
  it('maps events to merchant-safe labels in order', () => {
    const items = toTimeline(
      [
        ev('PAYMENT_CREATED'),
        ev('PAYMENT_SUBMITTED', { pspId: 'pspA', attempts: [{ code: 'BANK_UNAVAILABLE' }] }),
        ev('VERIFICATION_STARTED'),
        ev('CUSTOMER_DEBIT_DETECTED'),
        ev('REVERSAL_INITIATED'),
        ev('REVERSAL_COMPLETED'),
        ev('CASE_OPENED', { reason: 'DEBITED_NOT_CAPTURED' }),
        ev('CASE_RESOLVED', { resolution: 'REVERSED_TO_CUSTOMER' }),
      ],
      users,
    );
    expect(items.map((i) => i.label)).toEqual([
      'Payment initiated',
      'Sent to payment provider',
      'Payment verification started',
      'Customer account debited',
      'Auto-reversal to customer initiated',
      'Auto-reversal to customer completed',
      'Issue opened: Customer debited, payment not captured',
      'Issue resolved: Reversed to customer',
    ]);
    expect(items[1]!.detail).toBe('Provider: pspA');
  });

  it('never leaks internal data such as PSP codes or check counts', () => {
    const items = toTimeline(
      [
        ev('PAYMENT_SUBMITTED', { pspId: 'pspA', attempts: [{ code: 'BANK_UNAVAILABLE' }] }),
        ev('STATUS_CHECKED', { result: 'FOUND', outcome: 'FAILED', failureCode: 'U30' }),
        ev('PAYMENT_STATE_CHANGED', { to: 'FAILED', code: 'U30' }),
      ],
      users,
    );
    for (const item of items) {
      expect(Object.keys(item).every((k) => ALLOWED_KEYS.includes(k))).toBe(true);
    }
    expect(JSON.stringify(items)).not.toMatch(/U30|BANK_UNAVAILABLE|failureCode/);
  });

  it('collapses consecutive status checks into one line with a count', () => {
    const items = toTimeline([ev('VERIFICATION_STARTED'), ev('STATUS_CHECKED'), ev('STATUS_CHECKED'), ev('STATUS_CHECKED'), ev('CUSTOMER_DEBIT_DETECTED'), ev('STATUS_CHECKED')], users);
    expect(items.map((i) => [i.label, i.count ?? 1])).toEqual([
      ['Payment verification started', 1],
      ['Status checked with payment provider', 3],
      ['Customer account debited', 1],
      ['Status checked with payment provider', 1],
    ]);
  });

  it('attributes user actions and keeps audit-only events out of the timeline', () => {
    const items = toTimeline(
      [ev('PAYMENT_VIEWED', {}, 'usr_1'), ev('RECHECK_REQUESTED', {}, 'usr_1'), ev('NOTE_ADDED', {}, 'usr_1'), ev('LOGIN_SUCCEEDED', {}, 'usr_1')],
      users,
    );
    expect(items.map((i) => [i.label, i.actor])).toEqual([
      ['Recheck requested', 'Priya (Support)'],
      ['Note added', 'Priya (Support)'],
    ]);
  });

  it('labels mock UDIR complaints as simulated', () => {
    const [item] = toTimeline([ev('UDIR_COMPLAINT_RAISED', { mode: 'MOCK', pspComplaintRef: 'MOCK-UDIR-000001' }, 'usr_1')], users);
    expect(item!.label).toBe('UDIR complaint raised (simulated — mock PSP, not sent to NPCI)');
    expect(item!.detail).toBe('Reference: MOCK-UDIR-000001');
  });

  it('describes state changes and complaint updates in plain words', () => {
    const items = toTimeline(
      [ev('PAYMENT_STATE_CHANGED', { to: 'SUCCEEDED' }), ev('UDIR_COMPLAINT_UPDATED', { status: 'RESOLVED_REVERSED' }), ev('CASE_STATUS_CHANGED', { to: 'NEEDS_ACTION' })],
      users,
    );
    expect(items.map((i) => i.label)).toEqual([
      'Payment marked successful',
      'UDIR complaint resolved — amount reversed',
      'Issue status: Needs action',
    ]);
  });
});
