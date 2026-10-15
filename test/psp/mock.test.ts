import { describe, expect, it } from 'vitest';
import { MockPsp, mockRrn } from '../../src/psp/mock.js';
import { PspRegistry } from '../../src/psp/registry.js';
import type { TransactionInquiry } from '../../src/psp/types.js';

const collect = (psp: MockPsp, txnRef: string) => psp.collect({ txnRef, channel: 'UPI_COLLECT', payerVpa: 'a@ok', amountPaise: 100 });

describe('MockPsp — Phase 3 capabilities', () => {
  it('identifies itself as MOCK', () => {
    expect(new MockPsp('pspA').mode).toBe('MOCK');
  });

  it('derives a deterministic 12-digit RRN per PSP + txnRef', () => {
    expect(mockRrn('pspA', 'pay_1-1')).toMatch(/^\d{12}$/);
    expect(mockRrn('pspA', 'pay_1-1')).toBe(mockRrn('pspA', 'pay_1-1'));
    expect(mockRrn('pspA', 'pay_1-1')).not.toBe(mockRrn('pspA', 'pay_1-2'));
  });

  it('attaches the RRN to unscripted successes', async () => {
    const psp = new MockPsp('pspA');
    const r = await collect(psp, 't1');
    expect(r).toMatchObject({ kind: 'SUCCESS', upiRrn: mockRrn('pspA', 't1') });
  });

  it('derives inquiry facts from what the PSP processed', async () => {
    const psp = new MockPsp('pspA', {
      script: [
        { kind: 'SUCCESS', pspTxnId: 'x' },
        { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' },
        { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } },
      ],
    });
    await collect(psp, 'ok');
    await collect(psp, 'bd');
    await collect(psp, 'pend');
    expect(await psp.inquire('ok')).toEqual({
      found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED',
      reversal: { status: 'NONE' }, upiRrn: mockRrn('pspA', 'ok'), npciTxnId: 'MOCKpspAok',
    });
    expect(await psp.inquire('bd')).toMatchObject({ outcome: 'FAILED', customerDebit: 'NOT_DEBITED', capture: 'NOT_CAPTURED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await psp.inquire('pend')).toMatchObject({ outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN' });
    expect(await psp.inquire('never-seen')).toEqual({ found: false });
  });

  it('plays scripted inquiries in order and repeats the last one', async () => {
    const psp = new MockPsp('pspA');
    const debited: TransactionInquiry = { found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' } };
    const reversed: TransactionInquiry = { ...debited, reversal: { status: 'COMPLETED', completedAt: new Date('2026-10-16T06:00:00Z') } };
    psp.scriptInquiry('t9', [debited, reversed]);
    expect(await psp.inquire('t9')).toMatchObject({ reversal: { status: 'NONE' }, upiRrn: mockRrn('pspA', 't9') });
    expect(await psp.inquire('t9')).toMatchObject({ reversal: { status: 'COMPLETED' } });
    expect(await psp.inquire('t9')).toMatchObject({ reversal: { status: 'COMPLETED' } });
  });

  it('binds a queued script to the next transaction inquired without one', async () => {
    const psp = new MockPsp('pspA');
    psp.scriptNextInquiry([{ found: true, outcome: 'PENDING', customerDebit: 'DEBITED', capture: 'UNKNOWN', reversal: { status: 'NONE' } }]);
    expect(await psp.inquire('unknown-ref')).toMatchObject({ outcome: 'PENDING', customerDebit: 'DEBITED' });
    expect(await psp.inquire('another-ref')).toEqual({ found: false });
  });

  it('can simulate an enquiry outage', async () => {
    const psp = new MockPsp('pspA', { failInquiries: true });
    await expect(psp.inquire('x')).rejects.toThrow();
  });

  it('raises UDIR complaints idempotently and advances status by script', async () => {
    const psp = new MockPsp('pspA', { complaintScript: ['IN_PROGRESS', 'RESOLVED_REVERSED'] });
    const req = { txnRef: 't1', amountPaise: 100, reason: 'DEBITED_NOT_CREDITED' as const, idempotencyKey: 'cas_1' };
    const a = await psp.raiseComplaint(req);
    const b = await psp.raiseComplaint(req);
    expect(a).toEqual({ ok: true, pspComplaintRef: 'MOCK-UDIR-000001', status: 'SUBMITTED' });
    expect(b).toEqual(a);
    expect(await psp.complaintStatus('MOCK-UDIR-000001')).toMatchObject({ ok: true, status: 'IN_PROGRESS' });
    expect(await psp.complaintStatus('MOCK-UDIR-000001')).toMatchObject({ ok: true, status: 'RESOLVED_REVERSED' });
    expect(await psp.complaintStatus('MOCK-UDIR-000001')).toMatchObject({ ok: true, status: 'RESOLVED_REVERSED' });
    expect(await psp.complaintStatus('nope')).toMatchObject({ ok: false });
  });

  it('can simulate complaint submission failure', async () => {
    const psp = new MockPsp('pspA', { failComplaints: true });
    expect(await psp.raiseComplaint({ txnRef: 't', amountPaise: 1, reason: 'STATUS_UNKNOWN', idempotencyKey: 'k' })).toMatchObject({ ok: false, retryable: true });
  });
});

describe('PspRegistry', () => {
  it('looks up shared adapters by id', async () => {
    const a = new MockPsp('pspA');
    const reg = new PspRegistry([a, new MockPsp('pspB')]);
    expect(await reg.get('pspA')).toBe(a);
    expect(reg.sharedIds()).toEqual(['pspA', 'pspB']);
    await expect(reg.get('x')).rejects.toThrow(/Unknown PSP x/);
  });
});
