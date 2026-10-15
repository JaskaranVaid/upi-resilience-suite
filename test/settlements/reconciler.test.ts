import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentAttempts, paymentCases, paymentTracking, payments, pspConnections, reconRuns, settlements, webhookOutbox } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import type { MockPsp } from '../../src/psp/mock.js';
import type { SettlementItem } from '../../src/psp/types.js';
import { unmatchedCount } from '../../src/settlements/reconciler.js';
import { freshDb, ist, rs, seedMerchant } from '../helpers/fixtures.js';

describe('settlement reconciliation', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let merchantId: string;
  let connId: string;
  let psp: MockPsp;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 }, recon: { checkEveryMs: 0 } });
    merchantId = (await seedMerchant(db)).id;
    connId = newId('con');
    await db.insert(pspConnections).values({ id: connId, merchantId, provider: 'mock', label: 'Own mock', environment: 'sandbox' });
    psp = (await ctx.psps.get(connId)) as MockPsp;
  });

  const captured = async (amountPaise = rs(2500)) => {
    const { payment } = await ctx.payments.create(merchantId, { amountPaise, payerVpa: 'asha@okhdfc', idempotencyKey: newId('pay') });
    expect(payment.state).toBe('SUCCEEDED');
    return payment;
  };
  const line = (over: Partial<SettlementItem>): SettlementItem => ({
    pspEventId: newId('evt'),
    kind: 'PAYMENT',
    pspPaymentId: null,
    orderRef: null,
    amountPaise: rs(2500),
    feePaise: rs(10),
    taxPaise: rs(1.8),
    settledAmountPaise: rs(2488.2),
    settlementId: 'stl_1',
    utr: 'UTR0001',
    settledAt: ist('2026-10-16T10:00:00'),
    ...over,
  });
  const tracking = async (id: string) => (await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, id)))[0]!;
  const caseOf = async (id: string) => (await ctx.db.select().from(paymentCases).where(eq(paymentCases.subjectId, id)))[0];

  it('matches a line by the PSP payment id and records settlement facts once', async () => {
    const p = await captured();
    psp.addSettlements(line({ pspPaymentId: p.pspTxnId }));
    expect(await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16')).toEqual({ items: 1, matched: 1 });
    expect(await tracking(p.id)).toMatchObject({ settlementStatus: 'SETTLED', settlementUtr: 'UTR0001', settledAmountPaise: rs(2488.2), settlementFeePaise: rs(11.8) });
    // A finished day is not re-run, and re-recording the same line changes nothing.
    expect(await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16')).toBeNull();
    await ctx.db.update(reconRuns).set({ status: 'FAILED' });
    await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16');
    expect(await ctx.db.select().from(settlements)).toHaveLength(1);
    expect(await caseOf(p.id)).toBeUndefined();
  });

  it('matches by our reference when the PSP reports the order rather than its payment id', async () => {
    const p = await captured();
    const [attempt] = await ctx.db.select().from(paymentAttempts).where(and(eq(paymentAttempts.paymentId, p.id), eq(paymentAttempts.op, 'collect')));
    psp.addSettlements(line({ orderRef: attempt!.txnRef }));
    await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16');
    expect((await tracking(p.id)).settlementStatus).toBe('SETTLED');
  });

  it('opens a needs-action case when the settled amount differs from the captured amount', async () => {
    const p = await captured(rs(2500));
    psp.addSettlements(line({ pspPaymentId: p.pspTxnId, amountPaise: rs(2400) }));
    await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16');
    expect((await tracking(p.id)).settlementStatus).toBe('MISMATCH');
    expect(await caseOf(p.id)).toMatchObject({ reason: 'SETTLEMENT_MISMATCH', status: 'NEEDS_ACTION' });
    expect((await ctx.db.select().from(webhookOutbox).where(eq(webhookOutbox.event, 'case.needs_action'))).length).toBe(1);
  });

  it('keeps lines it cannot match, for review', async () => {
    psp.addSettlements(line({ pspPaymentId: 'unknown-psp-payment' }));
    expect(await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16')).toEqual({ items: 1, matched: 0 });
    expect(await unmatchedCount(ctx.db, merchantId)).toBe(1);
  });

  it('flags a capture still unsettled 3 days after reconciliation covered it, and resolves it when it settles', async () => {
    const p = await captured();
    clock.set(ist('2026-10-19T09:00:00')); // reports through 18 Oct are due
    expect(await ctx.reconciler.runDue()).toBeGreaterThan(0);
    expect(await caseOf(p.id)).toMatchObject({ reason: 'NOT_SETTLED', status: 'NEEDS_ACTION' });

    psp.addSettlements(line({ pspPaymentId: p.pspTxnId, settledAt: ist('2026-10-19T08:00:00') }));
    clock.set(ist('2026-10-20T09:00:00'));
    await ctx.reconciler.runDue();
    expect(await caseOf(p.id)).toMatchObject({ status: 'RESOLVED', resolution: 'SETTLED' });
  });

  it('does not flag captures before their day plus the grace period has been reconciled', async () => {
    const p = await captured();
    clock.set(ist('2026-10-17T09:00:00')); // only 15–16 Oct reconciled: within the grace period
    await ctx.reconciler.runDue();
    expect(await caseOf(p.id)).toBeUndefined();
  });

  it('marks a day failed when the report cannot be read, and retries it on the next run', async () => {
    const real = psp.settlements.bind(psp);
    psp.settlements = async () => {
      throw new Error('report API down');
    };
    await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16');
    expect((await ctx.db.select().from(reconRuns))[0]).toMatchObject({ status: 'FAILED', error: 'report API down' });
    psp.settlements = real;
    expect(await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16')).toEqual({ items: 0, matched: 0 });
    expect((await ctx.db.select().from(reconRuns))[0]).toMatchObject({ status: 'DONE' });
    expect((await ctx.db.select().from(payments)).length).toBe(0);
  });
});
