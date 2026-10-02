import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, paymentCases, paymentEvents, payments, paymentTracking, webhookOutbox } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import type { PspResult, TransactionInquiry } from '../../src/psp/types.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const BANK_DOWN: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
const inq = (over: Partial<Extract<TransactionInquiry, { found: true }>>): TransactionInquiry => ({
  found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: { status: 'NONE' }, ...over,
});
const DEBITED = { outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED' } as const;
const DEBITED_NOT_CAPTURED = inq(DEBITED);

describe('StatusPoller + TrackingService', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let pspA: MockPsp;
  let pspB: MockPsp;
  let merchantId: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    pspA = new MockPsp('pspA');
    pspB = new MockPsp('pspB');
    ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    merchantId = (await seedMerchant(db)).id;
  });

  const pay = (key = 'k1') => ctx.payments.create(merchantId, { amountPaise: rs(2500), payerVpa: 'ravi@okicici', idempotencyKey: key, orderId: `ORD-${key}` });
  const tracking = async (subjectId: string) =>
    (await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, subjectId)))[0]!;
  const caseOf = async (subjectId: string) =>
    (await ctx.db.select().from(paymentCases).where(eq(paymentCases.subjectId, subjectId)))[0];
  const paymentRow = async (id: string) => (await ctx.db.select().from(payments).where(eq(payments.id, id)))[0]!;
  const eventTypes = async (subjectId: string) =>
    (await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.subjectId, subjectId)).orderBy(asc(paymentEvents.seq))).map((e) => e.type);
  /** Jump to the next scheduled check and run the poller. */
  const nextCheck = async (subjectId: string) => {
    const t = await tracking(subjectId);
    if (!t.nextCheckAt) throw new Error('no check scheduled');
    clock.set(t.nextCheckAt);
    return ctx.poller.runOnce();
  };

  it('resolves a pending collect when the PSP confirms capture, and stops polling', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    pspA.scriptNextInquiry([inq({}), inq({}), inq({ outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', npciTxnId: 'NPCI123' })]);
    const { payment } = await pay();
    expect(payment.state).toBe('PENDING');
    expect((await tracking(payment.id)).verificationStatus).toBe('IN_PROGRESS');

    await nextCheck(payment.id);
    await nextCheck(payment.id);
    expect((await paymentRow(payment.id)).state).toBe('PENDING');
    await nextCheck(payment.id);

    const t = await tracking(payment.id);
    expect(t).toMatchObject({ verificationStatus: 'RESOLVED', capture: 'CAPTURED', customerDebit: 'DEBITED', nextCheckAt: null, checkCount: 3 });
    expect(t.upiRrn).toMatch(/^\d{12}$/);
    expect(await paymentRow(payment.id)).toMatchObject({ state: 'SUCCEEDED', pspTxnId: 'NPCI123' });
    expect(await caseOf(payment.id)).toBeUndefined();
    const hooks = (await ctx.db.select().from(webhookOutbox)).map((w) => w.event);
    expect(hooks).toContain('payment.succeeded');
    expect(await eventTypes(payment.id)).toEqual(expect.arrayContaining(['PAYMENT_CREATED', 'PAYMENT_SUBMITTED', 'VERIFICATION_STARTED', 'CAPTURE_CONFIRMED', 'PAYMENT_STATE_CHANGED', 'VERIFICATION_RESOLVED']));

    const inquiries = pspA.calls.filter((c) => c.op === 'inquire').length;
    clock.advance(3600_000);
    expect(await ctx.poller.runOnce()).toBe(0);
    expect(pspA.calls.filter((c) => c.op === 'inquire').length).toBe(inquiries);
  });

  it('tracks a failed-but-debited collect through bank auto-reversal and resolves its case', async () => {
    pspA.enqueue(BANK_DOWN);
    pspB.enqueue(BANK_DOWN);
    pspB.scriptNextInquiry([
      DEBITED_NOT_CAPTURED,
      inq({ ...DEBITED, reversal: { status: 'INITIATED', initiatedAt: ist('2026-10-15T14:05:00') } }),
      inq({ ...DEBITED, reversal: { status: 'COMPLETED', initiatedAt: ist('2026-10-15T14:05:00'), completedAt: ist('2026-10-15T16:00:00') } }),
    ]);
    const { payment } = await pay();
    expect(payment.state).toBe('FAILED');
    expect((await tracking(payment.id)).pspId).toBe('pspB');

    await nextCheck(payment.id);
    let c = await caseOf(payment.id);
    expect(c).toMatchObject({ reason: 'DEBITED_NOT_CAPTURED', status: 'REVERSAL_PENDING' });

    await nextCheck(payment.id);
    expect(await tracking(payment.id)).toMatchObject({ reversalStatus: 'INITIATED', reversalInitiatedAt: ist('2026-10-15T14:05:00') });
    expect((await caseOf(payment.id))!.status).toBe('REVERSAL_PENDING');

    await nextCheck(payment.id);
    expect(await tracking(payment.id)).toMatchObject({ reversalStatus: 'COMPLETED', reversalCompletedAt: ist('2026-10-15T16:00:00'), verificationStatus: 'RESOLVED' });
    c = await caseOf(payment.id);
    expect(c).toMatchObject({ status: 'RESOLVED', resolution: 'REVERSED_TO_CUSTOMER' });
    expect((await paymentRow(payment.id)).state).toBe('FAILED'); // payment outcome unchanged
    expect(await eventTypes(payment.id)).toEqual(expect.arrayContaining(['CUSTOMER_DEBIT_DETECTED', 'CASE_OPENED', 'REVERSAL_INITIATED', 'REVERSAL_COMPLETED', 'CASE_RESOLVED']));
  });

  it('resolves without a case when a failed collect turns out not to have been debited', async () => {
    pspA.enqueue(BANK_DOWN);
    pspB.enqueue(BANK_DOWN);
    const { payment } = await pay();
    await nextCheck(payment.id);
    expect(await tracking(payment.id)).toMatchObject({ verificationStatus: 'RESOLVED', customerDebit: 'NOT_DEBITED' });
    expect(await caseOf(payment.id)).toBeUndefined();
  });

  it('moves to manual investigation after the 48h budget and opens a needs-action case', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    const { payment } = await pay();
    let checks = 0;
    while ((await tracking(payment.id)).verificationStatus === 'IN_PROGRESS') {
      await nextCheck(payment.id);
      if (++checks > 400) throw new Error('poller never stopped');
    }
    const t = await tracking(payment.id);
    expect(t.verificationStatus).toBe('NEEDS_MANUAL_INVESTIGATION');
    expect(clock.now().getTime() - t.verificationStartedAt!.getTime()).toBeLessThanOrEqual(48 * 3600_000);
    expect(checks).toBeGreaterThan(190);
    expect(await caseOf(payment.id)).toMatchObject({ reason: 'VERIFICATION_EXHAUSTED', status: 'NEEDS_ACTION' });
    clock.advance(24 * 3600_000);
    expect(await ctx.poller.runOnce()).toBe(0); // polling has stopped for good
  });

  it('flags a late capture after failure as a mismatch without flipping the payment', async () => {
    pspA.enqueue(BANK_DOWN);
    pspB.enqueue(BANK_DOWN);
    pspB.scriptNextInquiry([inq({ outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED' })]);
    const { payment } = await pay();
    await nextCheck(payment.id);
    expect((await paymentRow(payment.id)).state).toBe('FAILED');
    expect(await caseOf(payment.id)).toMatchObject({ reason: 'STATUS_MISMATCH', status: 'NEEDS_ACTION' });
    const hooks = (await ctx.db.select().from(webhookOutbox)).map((w) => w.event);
    expect(hooks).not.toContain('payment.succeeded');
  });

  it('keeps the schedule when the PSP enquiry API errors', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    const { payment } = await pay();
    (pspA as unknown as { opts: { failInquiries: boolean } }).opts.failInquiries = true;
    await nextCheck(payment.id);
    expect(await tracking(payment.id)).toMatchObject({ verificationStatus: 'IN_PROGRESS', checkCount: 1, leaseUntil: null });
  });

  it('never runs two checks for the same payment at once', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    const { payment } = await pay();
    const t = await tracking(payment.id);
    clock.set(t.nextCheckAt!);
    await ctx.db.update(paymentTracking).set({ leaseUntil: new Date(clock.now().getTime() + 10_000) }).where(eq(paymentTracking.id, t.id));
    const before = pspA.calls.filter((c) => c.op === 'inquire').length;
    expect(await ctx.poller.runOnce()).toBe(0);
    await expect(ctx.tracking.check(t.id, { type: 'DASHBOARD_USER', id: 'usr_x' }, { manual: true })).rejects.toMatchObject({ code: 'CHECK_IN_PROGRESS' });
    expect(pspA.calls.filter((c) => c.op === 'inquire').length).toBe(before);
  });

  it('rate-limits manual rechecks and records who asked', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    const { payment } = await pay();
    const t = await tracking(payment.id);
    const user = { type: 'DASHBOARD_USER' as const, id: 'usr_1' };
    await ctx.tracking.check(t.id, user, { manual: true });
    await expect(ctx.tracking.check(t.id, user, { manual: true })).rejects.toMatchObject({ code: 'RECHECK_TOO_SOON' });
    clock.advance(10_000);
    await ctx.tracking.check(t.id, user, { manual: true });
    const rechecks = await ctx.db
      .select()
      .from(paymentEvents)
      .where(and(eq(paymentEvents.subjectId, payment.id), eq(paymentEvents.type, 'RECHECK_REQUESTED')));
    expect(rechecks.map((e) => e.actorId)).toEqual(['usr_1', 'usr_1']);
    expect(await ctx.poller.runOnce()).toBe(0); // manual checks don't make the poller double up
  });

  describe('AutoPay debits', () => {
    const scheduleDebit = async (eligible: string[]) => {
      const md = await seedMandate(ctx.db, merchantId, { eligiblePsps: eligible });
      const { debit } = await ctx.scheduler.createDebit(merchantId, md.id, { amountPaise: rs(499), idempotencyKey: `inv-${md.id}`, orderId: 'INV-1' });
      return debit;
    };
    const runWorkerUntilDone = async (id: string) => {
      for (let i = 0; i < 10; i++) {
        const [d] = await ctx.db.select().from(debits).where(eq(debits.id, id));
        if (d!.state === 'SUCCEEDED' || d!.state === 'FAILED') return d!;
        clock.set(d!.scheduledAt);
        await ctx.worker.runOnce();
      }
      throw new Error('debit never finished');
    };

    it('records capture for a successful debit so it is searchable by RRN', async () => {
      const d = await runWorkerUntilDone((await scheduleDebit(['pspA'])).id);
      expect(d.state).toBe('SUCCEEDED');
      const t = await tracking(d.id);
      expect(t).toMatchObject({ subjectType: 'AUTOPAY', capture: 'CAPTURED', customerDebit: 'DEBITED', verificationStatus: 'NOT_REQUIRED' });
      expect(t.upiRrn).toMatch(/^\d{12}$/);
      expect(await eventTypes(d.id)).toEqual(expect.arrayContaining(['PAYMENT_CREATED', 'PAYMENT_SUBMITTED', 'PAYMENT_STATE_CHANGED']));
    });

    it('starts a watch when a debit finally fails on technical declines', async () => {
      pspA.enqueue(BANK_DOWN, BANK_DOWN, BANK_DOWN);
      const d = await runWorkerUntilDone((await scheduleDebit(['pspA'])).id);
      expect(d.state).toBe('FAILED');
      expect(await tracking(d.id)).toMatchObject({ verificationStatus: 'IN_PROGRESS', pspId: 'pspA' });
      await nextCheck(d.id);
      expect(await tracking(d.id)).toMatchObject({ verificationStatus: 'RESOLVED', customerDebit: 'NOT_DEBITED' });
      expect((await ctx.db.select().from(debits).where(eq(debits.id, d.id)))[0]!.state).toBe('FAILED'); // worker owns debit state
    });

    it('does not watch business declines', async () => {
      pspA.enqueue({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
      const d = await runWorkerUntilDone((await scheduleDebit(['pspA'])).id);
      expect(await tracking(d.id)).toMatchObject({ verificationStatus: 'NOT_REQUIRED', customerDebit: 'NOT_DEBITED' });
    });

    it('hands debits the worker could not resolve in 48h straight to manual investigation', async () => {
      pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
      const debit = await scheduleDebit(['pspA']);
      clock.set(debit.scheduledAt);
      await ctx.worker.runOnce();
      for (let i = 0; i < 1000; i++) {
        const [d] = await ctx.db.select().from(debits).where(eq(debits.id, debit.id));
        if (d!.state === 'FAILED') break;
        clock.set(d!.scheduledAt);
        await ctx.worker.runOnce();
      }
      const [d] = await ctx.db.select().from(debits).where(eq(debits.id, debit.id));
      expect(d).toMatchObject({ state: 'FAILED', lastErrorCode: 'UNRESOLVED_PENDING' });
      expect((await tracking(debit.id)).verificationStatus).toBe('NEEDS_MANUAL_INVESTIGATION');
      expect(await caseOf(debit.id)).toMatchObject({ reason: 'VERIFICATION_EXHAUSTED', status: 'NEEDS_ACTION' });
    });
  });
});
