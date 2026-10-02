import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentEvents, paymentTracking } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import type { PspResult, TransactionInquiry } from '../../src/psp/types.js';
import { freshDb, ist, rs, seedMandate } from '../helpers/fixtures.js';

const ADMIN_TOKEN = 'test-admin-token-123';
const PW = 'correct horse battery';
const BANK_DOWN: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
const DEBITED: TransactionInquiry = { found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' } };
/** Internal detail that must never reach the dashboard. */
const INTERNAL = /lastErrorCode|checkCount|nextCheckAt|leaseUntil|txnRef|failureCode|BANK_UNAVAILABLE|passwordHash|apiKeyHash|webhookSecret/;

describe('dashboard data API', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let pspA: MockPsp;
  let pspB: MockPsp;
  let apiKey: string;
  let merchantId: string;
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    pspA = new MockPsp('pspA');
    pspB = new MockPsp('pspB');
    ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: ADMIN_TOKEN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    const m = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name: 'StreamCo' } });
    apiKey = m.json().apiKey;
    merchantId = m.json().merchant.id;
    for (const role of ['ADMIN', 'SUPPORT', 'VIEWER']) {
      const email = `${role.toLowerCase()}@streamco.example`;
      await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${apiKey}` }, payload: { email, name: `${role[0]}${role.slice(1).toLowerCase()} User`, password: PW, role } });
      const res = await app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email, password: PW } });
      cookies[role] = `rs_session=${res.cookies.find((c) => c.name === 'rs_session')!.value}`;
    }
  });

  const get = (role: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookies[role]! } });
  const post = (role: string, url: string, payload: object = {}) =>
    app.inject({ method: 'POST', url, payload, headers: { cookie: cookies[role]!, 'x-dashboard-request': '1' } });
  const collect = (key: string, amount = rs(2500)) =>
    app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${apiKey}` }, payload: { amountPaise: amount, payerVpa: 'ravi@okicici', idempotencyKey: key, orderId: `ORD-${key}` } });

  /** Collect that failed on infrastructure but debited the customer, after one poller check. */
  async function debitedPayment(key: string) {
    pspA.enqueue(BANK_DOWN);
    pspB.enqueue(BANK_DOWN);
    pspB.scriptNextInquiry([DEBITED]);
    const p = (await collect(key)).json();
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
    clock.set(t!.nextCheckAt!);
    await ctx.poller.runOnce();
    return p as { id: string };
  }

  it('overview counts collects and AutoPay debits together', async () => {
    await collect('ok1');
    await collect('ok2');
    pspA.enqueue({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
    await collect('declined');
    await debitedPayment('debited');
    const md = await seedMandate(ctx.db, merchantId);
    await ctx.scheduler.createDebit(merchantId, md.id, { amountPaise: rs(499), idempotencyKey: 'inv-1' });

    const o = (await get('VIEWER', '/dashboard/api/overview')).json();
    expect(o).toMatchObject({ total: 5, succeeded: 2, failed: 1, debitedNotCaptured: 1, inProgress: 1, reversalsPending: 0, casesNeedingAction: 0 });
    expect(o.byStatus.SCHEDULED).toBe(1);
  });

  it('lists with filters and cursor pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await collect(`p${i}`, rs(100 * (i + 1)));
      clock.advance(1000);
    }
    const md = await seedMandate(ctx.db, merchantId);
    await ctx.scheduler.createDebit(merchantId, md.id, { amountPaise: rs(499), idempotencyKey: 'inv-1', orderId: 'INV-9' });

    const page1 = (await get('VIEWER', '/dashboard/api/payments?limit=4')).json();
    expect(page1.data).toHaveLength(4);
    const page2 = (await get('VIEWER', `/dashboard/api/payments?limit=4&cursor=${page1.nextCursor}`)).json();
    expect(page2.data).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.data, ...page2.data].map((p: { id: string }) => p.id)).size).toBe(6);

    expect((await get('VIEWER', '/dashboard/api/payments?type=autopay')).json().data.map((p: { orderId: string }) => p.orderId)).toEqual(['INV-9']);
    expect((await get('VIEWER', '/dashboard/api/payments?status=SCHEDULED')).json().data).toHaveLength(1);
    expect((await get('VIEWER', '/dashboard/api/payments?status=SUCCEEDED&minAmount=30000')).json().data).toHaveLength(3);
    expect((await get('VIEWER', '/dashboard/api/payments?orderId=ORD-p2')).json().data).toHaveLength(1);
    expect((await get('VIEWER', '/dashboard/api/payments?psp=pspB')).json().data).toHaveLength(0);
    expect((await get('VIEWER', '/dashboard/api/payments?upiRrn=12345')).statusCode).toBe(400);
  });

  it('search resolves a 12-digit UPI reference, a payment id, or an order id', async () => {
    const p = (await collect('find-me')).json();
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
    const rrn = t!.upiRrn!;
    expect(rrn).toMatch(/^\d{12}$/);
    for (const q of [rrn, p.id, 'ORD-find-me']) {
      const r = (await get('VIEWER', `/dashboard/api/payments/search?q=${q}`)).json();
      expect(r.matches.map((m: { id: string }) => m.id)).toEqual([p.id]);
    }
    expect((await get('VIEWER', '/dashboard/api/payments/search?q=999999999999')).json().matches).toEqual([]);
  });

  it('payment detail answers the merchant questions without leaking internals, and audits the view', async () => {
    const p = await debitedPayment('d1');
    const res = await get('VIEWER', `/dashboard/api/payments/collect/${p.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({
      type: 'COLLECT',
      orderId: 'ORD-d1',
      merchantStatus: 'DEBITED_NOT_CAPTURED',
      money: {
        customerDebit: { code: 'DEBITED', label: 'Debited' },
        capture: { code: 'NOT_CAPTURED', note: expect.stringMatching(/not a bank settlement/) },
        reversal: { code: 'NONE' },
      },
      resolution: { verification: { code: 'IN_PROGRESS' }, openCase: { status: 'REVERSAL_PENDING' }, actionRequired: false },
      customerView: { status: 'verification_in_progress' },
      providerMode: 'MOCK',
      actionsAllowed: [],
    });
    expect(d.resolution.nextStep).toMatch(/auto-reversal/);
    expect(JSON.stringify(d)).not.toMatch(INTERNAL);
    const viewed = await ctx.db.select().from(paymentEvents).where(and(eq(paymentEvents.subjectId, p.id), eq(paymentEvents.type, 'PAYMENT_VIEWED')));
    expect(viewed).toHaveLength(1);

    const timeline = (await get('VIEWER', `/dashboard/api/payments/collect/${p.id}/timeline`)).json().events;
    expect(timeline.map((e: { label: string }) => e.label)).toEqual(expect.arrayContaining(['Payment initiated', 'Customer account debited', 'Issue opened: Customer debited, payment not captured']));
    expect(JSON.stringify(timeline)).not.toMatch(INTERNAL);
  });

  it('viewers can read but not act; support and admin can act', async () => {
    const p = await debitedPayment('d2');
    const caseId = (await get('VIEWER', `/dashboard/api/payments/collect/${p.id}`)).json().resolution.openCase.id;
    for (const [url, body] of [
      [`/dashboard/api/payments/collect/${p.id}/recheck`, {}],
      [`/dashboard/api/payments/collect/${p.id}/complaints`, {}],
      [`/dashboard/api/cases/${caseId}/notes`, { body: 'x' }],
      [`/dashboard/api/cases/${caseId}/recheck`, {}],
      [`/dashboard/api/cases/${caseId}/close`, { note: 'x' }],
    ] as const) {
      expect((await post('VIEWER', url, body)).statusCode).toBe(403);
    }
    expect((await get('VIEWER', `/dashboard/api/cases/${caseId}`)).statusCode).toBe(200);
    expect((await get('SUPPORT', `/dashboard/api/payments/collect/${p.id}`)).json().actionsAllowed).toEqual(['RECHECK', 'RAISE_COMPLAINT']);
    expect((await post('SUPPORT', `/dashboard/api/cases/${caseId}/notes`, { body: 'Called the customer.' })).statusCode).toBe(201);
    expect((await post('ADMIN', `/dashboard/api/payments/collect/${p.id}/recheck`)).statusCode).toBe(200);
  });

  it('support resolves an issue end to end: search → detail → note → recheck → UDIR complaint', async () => {
    const p = await debitedPayment('d3');
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
    const found = (await get('SUPPORT', `/dashboard/api/payments/search?q=${t!.upiRrn}`)).json().matches;
    expect(found).toHaveLength(1);
    expect(found[0].caseId).not.toBeNull();

    const desk = (await get('SUPPORT', '/dashboard/api/cases?status=REVERSAL_PENDING')).json();
    expect(desk.counts.REVERSAL_PENDING).toBe(1);
    expect(desk.data[0]).toMatchObject({ id: found[0].caseId, reasonLabel: 'Customer debited, payment not captured', payment: { id: p.id } });

    await post('SUPPORT', `/dashboard/api/cases/${found[0].caseId}/notes`, { body: 'Customer says ₹2,500 left their account.' });
    clock.advance(30_000);
    expect((await post('SUPPORT', `/dashboard/api/cases/${found[0].caseId}/recheck`)).statusCode).toBe(200);
    const raised = await post('SUPPORT', `/dashboard/api/payments/collect/${p.id}/complaints`, { reason: 'DEBITED_NOT_CREDITED' });
    expect(raised.statusCode).toBe(201);
    const c = raised.json();
    expect(c).toMatchObject({ status: 'INVESTIGATING', complaints: [{ mode: 'MOCK', modeLabel: 'Simulated — mock PSP, not sent to NPCI', reference: 'MOCK-UDIR-000001', raisedBy: 'Support User' }] });
    expect(c.notes).toEqual([expect.objectContaining({ author: 'Support User', body: 'Customer says ₹2,500 left their account.' })]);
    expect(c.timeline.map((e: { label: string; actor?: string }) => [e.label, e.actor])).toEqual(
      expect.arrayContaining([
        ['Note added', 'Support User'],
        ['Recheck requested', 'Support User'],
        ['UDIR complaint raised (simulated — mock PSP, not sent to NPCI)', 'Support User'],
      ]),
    );
    expect(c.payment.actionsAllowed).toEqual(['RECHECK']); // complaint already open
    expect(JSON.stringify(c)).not.toMatch(INTERNAL);

    const viewed = await get('SUPPORT', `/dashboard/api/cases/${c.id}`);
    expect(viewed.statusCode).toBe(200);
    expect(await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.type, 'CASE_VIEWED'))).toHaveLength(1);
  });

  it('rejects a complaint the rules do not allow, with a clear reason', async () => {
    const p = (await collect('ok')).json();
    const res = await post('SUPPORT', `/dashboard/api/payments/collect/${p.id}/complaints`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/captured successfully/);
    expect((await get('SUPPORT', `/dashboard/api/payments/collect/${p.id}`)).json().complaintUnavailableReason).toMatch(/captured successfully/);
  });

  it('isolates merchants', async () => {
    const p = await debitedPayment('d4');
    const caseId = (await get('VIEWER', `/dashboard/api/payments/collect/${p.id}`)).json().resolution.openCase.id;
    const other = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name: 'Other' } });
    await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${other.json().apiKey}` }, payload: { email: 'o@other.example', name: 'O', password: PW, role: 'ADMIN' } });
    const login = await app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email: 'o@other.example', password: PW } });
    cookies.OTHER = `rs_session=${login.cookies.find((c) => c.name === 'rs_session')!.value}`;

    expect((await get('OTHER', `/dashboard/api/payments/collect/${p.id}`)).statusCode).toBe(404);
    expect((await get('OTHER', `/dashboard/api/payments/collect/${p.id}/timeline`)).statusCode).toBe(404);
    expect((await get('OTHER', `/dashboard/api/cases/${caseId}`)).statusCode).toBe(404);
    expect((await post('OTHER', `/dashboard/api/payments/collect/${p.id}/recheck`)).statusCode).toBe(404);
    expect((await get('OTHER', '/dashboard/api/payments')).json().data).toEqual([]);
    expect((await get('OTHER', '/dashboard/api/overview')).json().total).toBe(0);
  });
});
