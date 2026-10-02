import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentEvents, paymentTracking, udirComplaints } from '../../src/db/schema.js';
import { MockPsp, type MockPspOptions } from '../../src/psp/mock.js';
import type { PspResult, TransactionInquiry } from '../../src/psp/types.js';
import { freshDb, ist, rs, seedMerchant } from '../helpers/fixtures.js';

const BANK_DOWN: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
const DEBITED: TransactionInquiry = { found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' } };
const user = { type: 'DASHBOARD_USER' as const, id: 'usr_support' };

describe('DisputeService', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let psp: MockPsp;
  let merchantId: string;

  async function setup(opts: MockPspOptions = {}) {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    psp = new MockPsp('pspA', opts);
    ctx = buildContext({ db, adapters: [psp], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    merchantId = (await seedMerchant(db)).id;
  }

  /** A collect that failed on a technical decline and that the PSP says debited the customer. */
  async function debitedPayment() {
    psp.enqueue(BANK_DOWN);
    psp.scriptNextInquiry([DEBITED]);
    const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(2500), payerVpa: 'ravi@okicici', idempotencyKey: `k${Math.random()}` });
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, payment.id));
    clock.set(t!.nextCheckAt!);
    await ctx.poller.runOnce();
    return payment;
  }
  const ref = (id: string) => ({ type: 'COLLECT' as const, id });

  describe('raising a UDIR complaint', () => {
    beforeEach(() => setup({ complaintScript: ['IN_PROGRESS', 'RESOLVED_REVERSED'] }));

    it('attaches a MOCK-mode complaint to the open case, attributes it, and restarts the watch', async () => {
      const p = await debitedPayment();
      const before = await ctx.disputes.openCaseFor(merchantId, ref(p.id));
      expect(before).toMatchObject({ reason: 'DEBITED_NOT_CAPTURED', status: 'REVERSAL_PENDING' });

      const c = await ctx.disputes.raiseComplaint(merchantId, ref(p.id), user, 'DEBITED_NOT_CREDITED');
      expect(c.id).toBe(before!.id);
      expect(c.status).toBe('INVESTIGATING');

      const [complaint] = await ctx.db.select().from(udirComplaints).where(eq(udirComplaints.caseId, c.id));
      expect(complaint).toMatchObject({ mode: 'MOCK', pspComplaintRef: 'MOCK-UDIR-000001', status: 'SUBMITTED', raisedByUserId: 'usr_support', reasonCode: 'DEBITED_NOT_CREDITED' });
      const [raised] = await ctx.db.select().from(paymentEvents).where(and(eq(paymentEvents.caseId, c.id), eq(paymentEvents.type, 'UDIR_COMPLAINT_RAISED')));
      expect(raised).toMatchObject({ actorType: 'DASHBOARD_USER', actorId: 'usr_support' });
      const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
      expect(t!.verificationStatus).toBe('IN_PROGRESS');
    });

    it('is idempotent while a complaint is active', async () => {
      const p = await debitedPayment();
      const a = await ctx.disputes.raiseComplaint(merchantId, ref(p.id), user, 'DEBITED_NOT_CREDITED');
      const b = await ctx.disputes.raiseComplaint(merchantId, ref(p.id), user, 'DEBITED_NOT_CREDITED');
      expect(b.id).toBe(a.id);
      expect(psp.calls.filter((c) => c.op === 'complaint')).toHaveLength(1);
    });

    it('follows complaint progress through the poller and resolves the case', async () => {
      const p = await debitedPayment();
      const c = await ctx.disputes.raiseComplaint(merchantId, ref(p.id), user, 'DEBITED_NOT_CREDITED');
      const tick = async () => {
        const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
        clock.set(t!.nextCheckAt!);
        await ctx.poller.runOnce();
      };
      await tick();
      expect((await ctx.disputes.getCase(merchantId, c.id)).complaints[0]!.status).toBe('IN_PROGRESS');
      await tick();
      const detail = await ctx.disputes.getCase(merchantId, c.id);
      expect(detail.complaints[0]!.status).toBe('RESOLVED_REVERSED');
      // A complaint resolved as "reversed" is an observed reversal: money facts agree with it.
      expect(detail.case).toMatchObject({ status: 'RESOLVED', resolution: 'REVERSED_TO_CUSTOMER' });
      const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
      expect(t).toMatchObject({ reversalStatus: 'COMPLETED', verificationStatus: 'RESOLVED' });
      expect(t!.reversalCompletedAt).not.toBeNull();
      await expect(ctx.disputes.raiseComplaint(merchantId, ref(p.id), user, 'DEBITED_NOT_CREDITED')).rejects.toMatchObject({
        code: 'COMPLAINT_NOT_ALLOWED',
        message: expect.stringMatching(/already been reversed/),
      });
    });

    it('refuses when the customer was not debited', async () => {
      psp.enqueue(BANK_DOWN);
      const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(100), payerVpa: 'a@ok', idempotencyKey: 'nd' });
      await ctx.disputes.recheck(merchantId, ref(payment.id), user); // PSP has a FAILED record → not debited
      await expect(ctx.disputes.raiseComplaint(merchantId, ref(payment.id), user, 'DEBITED_NOT_CREDITED')).rejects.toMatchObject({ code: 'COMPLAINT_NOT_ALLOWED' });
    });

    it('refuses for a successfully captured payment', async () => {
      const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(100), payerVpa: 'a@ok', idempotencyKey: 'ok' });
      await expect(ctx.disputes.raiseComplaint(merchantId, ref(payment.id), user, 'STATUS_UNKNOWN')).rejects.toMatchObject({ code: 'COMPLAINT_NOT_ALLOWED' });
    });
  });

  it('persists nothing when the PSP rejects the complaint submission', async () => {
    await setup({ failComplaints: true });
    const p = await debitedPayment();
    await expect(ctx.disputes.raiseComplaint(merchantId, ref(p.id), user, 'DEBITED_NOT_CREDITED')).rejects.toMatchObject({ code: 'COMPLAINT_FAILED' });
    expect(await ctx.db.select().from(udirComplaints)).toHaveLength(0);
  });

  describe('notes, closing and isolation', () => {
    beforeEach(() => setup());

    it('appends attributed notes', async () => {
      const p = await debitedPayment();
      const c = (await ctx.disputes.openCaseFor(merchantId, ref(p.id)))!;
      await ctx.disputes.addNote(merchantId, c.id, user, 'Customer called; told them the bank will reverse it.');
      const detail = await ctx.disputes.getCase(merchantId, c.id);
      expect(detail.notes.map((n) => [n.authorUserId, n.body])).toEqual([['usr_support', 'Customer called; told them the bank will reverse it.']]);
    });

    it('lets the merchant close a needs-action case with a note', async () => {
      psp.enqueue(BANK_DOWN);
      psp.scriptNextInquiry([{ found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' } }]);
      const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(100), payerVpa: 'a@ok', idempotencyKey: 'late' });
      await ctx.disputes.recheck(merchantId, ref(payment.id), user);
      const c = (await ctx.disputes.openCaseFor(merchantId, ref(payment.id)))!;
      expect(c).toMatchObject({ reason: 'STATUS_MISMATCH', status: 'NEEDS_ACTION' });
      const closed = await ctx.disputes.closeCase(merchantId, c.id, user, 'Order fulfilled manually.');
      expect(closed).toMatchObject({ status: 'RESOLVED', resolution: 'CLOSED_BY_MERCHANT' });
      await expect(ctx.disputes.closeCase(merchantId, c.id, user, 'again')).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('builds tracking on demand for payments created before Phase 3', async () => {
      const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(100), payerVpa: 'a@ok', idempotencyKey: 'legacy' });
      await ctx.db.delete(paymentTracking).where(eq(paymentTracking.subjectId, payment.id));
      clock.advance(60_000);
      const r = await ctx.disputes.recheck(merchantId, ref(payment.id), user);
      expect(r.tracking).toMatchObject({ pspId: 'pspA', capture: 'CAPTURED', verificationStatus: 'NOT_REQUIRED', checkCount: 1 });
    });

    it('never exposes another merchant’s payments or cases', async () => {
      const p = await debitedPayment();
      const c = (await ctx.disputes.openCaseFor(merchantId, ref(p.id)))!;
      const other = (await seedMerchant(ctx.db)).id;
      await expect(ctx.disputes.recheck(other, ref(p.id), user)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ctx.disputes.getCase(other, c.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(ctx.disputes.addNote(other, c.id, user, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('lists cases with per-status counts', async () => {
      await debitedPayment();
      await debitedPayment();
      const r = await ctx.disputes.listCases(merchantId, { limit: 1 });
      expect(r.data).toHaveLength(1);
      expect(r.counts.REVERSAL_PENDING).toBe(2);
      expect(r.nextBefore).not.toBeNull();
    });
  });
});
