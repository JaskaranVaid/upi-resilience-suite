import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentAttempts, paymentCases, paymentTracking, payments, pspConnections, reconRuns, settlements, webhookOutbox } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { MockPsp } from '../../src/psp/mock.js';
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
    // Mock connections whose settlement report contains exactly what each test scripts.
    ctx = buildContext({
      db,
      adapters: [],
      adminToken: 'x'.repeat(20),
      clock,
      sleep: clock.sleep,
      router: { random: () => 0.5 },
      recon: { checkEveryMs: 0 },
      connectionAdapters: (row) => new MockPsp(row.id, { capabilities: { settlementReports: true } }),
    });
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

  it('matches a payment the poller confirmed later (pending at first, like every Razorpay payment) by the PSP payment id', async () => {
    const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(2500), channel: 'UPI_INTENT', idempotencyKey: 'intent-1' });
    expect(payment.state).toBe('PENDING');
    const t = await tracking(payment.id);
    clock.set(t.nextCheckAt!);
    await ctx.poller.runOnce(); // the customer paid: the PSP now reports success
    const [paid] = await ctx.db.select().from(payments).where(eq(payments.id, payment.id));
    expect(paid!.state).toBe('SUCCEEDED');
    // The report names the PSP's own payment id, which must be what we stored.
    const pspOwnId = `${connId}-1`;
    expect(paid!.pspTxnId).toBe(pspOwnId);
    psp.addSettlements(line({ pspPaymentId: pspOwnId }));
    await ctx.reconciler.reconcile(merchantId, connId, '2026-10-16');
    expect((await tracking(payment.id)).settlementStatus).toBe('SETTLED');
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

describe('settlement surfaces', () => {
  it('shows settlement in the payment detail, the API, analytics and the statement', async () => {
    const { buildApp } = await import('../../src/api/app.js');
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const ctx = buildContext({
      db,
      adapters: [],
      adminToken: 'x'.repeat(20),
      clock,
      sleep: clock.sleep,
      router: { random: () => 0.5 },
      connectionAdapters: (row) => new MockPsp(row.id, { capabilities: { settlementReports: true } }),
    });
    const app = buildApp(ctx);
    const onboard = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${'x'.repeat(20)}` }, payload: { name: 'Shop' } })).json();
    const key = onboard.apiKey as string;
    const merchantId = onboard.merchant.id as string;
    const conn = (await app.inject({ method: 'POST', url: '/v1/psp-connections', headers: { authorization: `Bearer ${key}` }, payload: { provider: 'mock' } })).json();
    const psp = (await ctx.psps.get(conn.id)) as MockPsp;
    const pay = (await app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${key}` }, payload: { amountPaise: rs(2500), payerVpa: 'asha@okhdfc', idempotencyKey: 's1' } })).json();
    psp.addSettlements({ pspEventId: 'e1', kind: 'PAYMENT', pspPaymentId: pay.pspTxnId, orderRef: null, amountPaise: rs(2500), feePaise: rs(10), taxPaise: rs(1.8), settledAmountPaise: rs(2488.2), settlementId: 's', utr: 'UTRX', settledAt: ist('2026-10-16T10:00:00') });
    psp.addSettlements({ pspEventId: 'e2', kind: 'PAYMENT', pspPaymentId: 'outside', orderRef: null, amountPaise: rs(99), feePaise: 0, taxPaise: 0, settledAmountPaise: rs(99), settlementId: 's', utr: 'UTRX', settledAt: ist('2026-10-16T10:00:00') });
    await ctx.reconciler.reconcile(merchantId, conn.id, '2026-10-16');

    const list = (await app.inject({ method: 'GET', url: '/v1/settlements?from=2026-10-01T00:00:00%2B05:30&to=2026-10-31T00:00:00%2B05:30', headers: { authorization: `Bearer ${key}` } })).json();
    expect(list.data).toHaveLength(2);
    expect(list.data.find((s: { pspPaymentId: string }) => s.pspPaymentId === pay.pspTxnId).payment).toEqual({ type: 'COLLECT', id: pay.id });
    const unmatched = (await app.inject({ method: 'GET', url: '/v1/settlements?match=unmatched&from=2026-10-01T00:00:00%2B05:30&to=2026-10-31T00:00:00%2B05:30', headers: { authorization: `Bearer ${key}` } })).json();
    expect(unmatched.data.map((s: { pspPaymentId: string }) => s.pspPaymentId)).toEqual(['outside']);

    // Dashboard: sign in as an admin created with the API key.
    await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${key}` }, payload: { email: 'a@shop.example', name: 'A', password: 'long-enough-pass', role: 'ADMIN' } });
    const login = await app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email: 'a@shop.example', password: 'long-enough-pass' } });
    const cookie = { cookie: `rs_session=${login.cookies.find((c) => c.name === 'rs_session')!.value}` };
    const detail = (await app.inject({ method: 'GET', url: `/dashboard/api/payments/collect/${pay.id}`, headers: cookie })).json();
    expect(detail.money.settlement).toMatchObject({ code: 'SETTLED', label: 'Settled to your account', utr: 'UTRX', netAmountPaise: rs(2488.2), feePaise: rs(11.8) });
    const summary = (await app.inject({ method: 'GET', url: '/dashboard/api/analytics/settlements?month=2026-10', headers: cookie })).json();
    expect(summary).toMatchObject({ captured: { count: 1, amountPaise: rs(2500) }, settled: { count: 1, netPaise: rs(2488.2), feesPaise: rs(11.8) }, settledShare: 1, unmatchedLines: { count: 1, amountPaise: rs(99) } });
    const csv = (await app.inject({ method: 'GET', url: '/dashboard/api/analytics/statement.csv?month=2026-10', headers: cookie })).body;
    expect(csv).toContain('Settlement,Settled to your account (net),1,2488.20,248820,100.00%');
  });
});

describe('test-mode mock connections', () => {
  it('simulate T+1 settlement, so reconciliation works end to end without false "not settled" cases', async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const ctx = buildContext({ db, adapters: [], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 }, recon: { checkEveryMs: 0 } });
    const merchantId = (await seedMerchant(db)).id;
    await db.insert(pspConnections).values({ id: newId('con'), merchantId, provider: 'mock', label: 'Test PSP', environment: 'sandbox' });
    const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(999), payerVpa: 'asha@okhdfc', idempotencyKey: 'k' });
    expect(payment.state).toBe('SUCCEEDED');
    clock.set(ist('2026-10-20T09:00:00'));
    await ctx.reconciler.runDue();
    const [t] = await db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, payment.id));
    expect(t).toMatchObject({ settlementStatus: 'SETTLED', settledAt: ist('2026-10-16T10:00:00') });
    expect(await db.select().from(paymentCases)).toEqual([]);
  });

  it('never flags captures from before reconciliation covered them, nor re-flags a case the merchant closed', async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-09-01T14:00:00'));
    const ctx = buildContext({
      db, adapters: [], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 }, recon: { checkEveryMs: 0 },
      connectionAdapters: (row) => new MockPsp(row.id, { capabilities: { settlementReports: true } }),
    });
    const merchantId = (await seedMerchant(db)).id;
    await db.insert(pspConnections).values({ id: newId('con'), merchantId, provider: 'mock', label: 'P', environment: 'sandbox' });
    const old = (await ctx.payments.create(merchantId, { amountPaise: rs(100), payerVpa: 'asha@okhdfc', idempotencyKey: 'old' })).payment;
    clock.set(ist('2026-10-15T14:00:00'));
    const recent = (await ctx.payments.create(merchantId, { amountPaise: rs(100), payerVpa: 'asha@okhdfc', idempotencyKey: 'new' })).payment;
    clock.set(ist('2026-10-19T09:00:00'));
    await ctx.reconciler.runDue();
    const cases = await db.select().from(paymentCases);
    expect(cases.map((c) => c.subjectId)).toEqual([recent.id]); // the September capture predates reconciliation
    await db.update(paymentCases).set({ status: 'RESOLVED', resolution: 'CLOSED_BY_MERCHANT', closedByMerchant: true });
    clock.set(ist('2026-10-20T09:00:00'));
    await ctx.reconciler.runDue();
    expect(await db.select().from(paymentCases)).toHaveLength(1);
    expect(old.id).not.toBe(recent.id);
  });

  it('lets a short-paid settlement take over an open "not settled" case', async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    let psp: MockPsp | undefined;
    const ctx = buildContext({
      db, adapters: [], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 }, recon: { checkEveryMs: 0 },
      connectionAdapters: (row) => (psp ??= new MockPsp(row.id, { capabilities: { settlementReports: true } })),
    });
    const merchantId = (await seedMerchant(db)).id;
    const connId = newId('con');
    await db.insert(pspConnections).values({ id: connId, merchantId, provider: 'mock', label: 'P', environment: 'sandbox' });
    const p = (await ctx.payments.create(merchantId, { amountPaise: rs(2500), payerVpa: 'asha@okhdfc', idempotencyKey: 'x' })).payment;
    clock.set(ist('2026-10-19T09:00:00'));
    await ctx.reconciler.runDue();
    expect((await db.select().from(paymentCases))[0]).toMatchObject({ reason: 'NOT_SETTLED' });
    psp!.addSettlements({ pspEventId: 'late', kind: 'PAYMENT', pspPaymentId: p.pspTxnId, orderRef: null, amountPaise: rs(2400), feePaise: 0, taxPaise: 0, settledAmountPaise: rs(2400), settlementId: 's', utr: 'U', settledAt: ist('2026-10-19T10:00:00') });
    clock.set(ist('2026-10-20T09:00:00'));
    await ctx.reconciler.runDue();
    expect(await db.select().from(paymentCases)).toEqual([expect.objectContaining({ reason: 'SETTLEMENT_MISMATCH', status: 'NEEDS_ACTION' })]);
  });
});
