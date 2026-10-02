import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentTracking } from '../../src/db/schema.js';
import { customerToken } from '../../src/payments/customer-token.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN_TOKEN = 'test-admin-token-123';

describe('customer-safe payment status', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let psp: MockPsp;
  let apiKey: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    psp = new MockPsp('pspA');
    ctx = buildContext({ db, adapters: [psp], adminToken: ADMIN_TOKEN, clock, sleep: clock.sleep, router: { random: () => 0.5 }, customerTokenSecret: 's'.repeat(40) });
    app = buildApp(ctx);
    apiKey = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name: 'Shop' } })).json().apiKey;
  });

  const create = (key: string) =>
    app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${apiKey}` }, payload: { amountPaise: rs(799), payerVpa: 'asha@okhdfc', idempotencyKey: key, orderId: 'ORD-77' } });
  const status = (id: string, token: string | undefined, via: 'header' | 'query' = 'header') =>
    app.inject({
      method: 'GET',
      url: `/public/payments/${id}/status${via === 'query' && token ? `?token=${token}` : ''}`,
      headers: via === 'header' && token ? { 'x-payment-token': token } : {},
    });

  it('returns a payment-scoped token on create, identical on idempotent replay, plus Phase 3 fields', async () => {
    const a = (await create('o1')).json();
    const b = (await create('o1')).json();
    expect(a.customerStatusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.customerStatusToken).toBe(a.customerStatusToken);
    expect(a).toMatchObject({ orderId: 'ORD-77', merchantStatus: 'SUCCEEDED', capture: 'CAPTURED', customerDebit: 'DEBITED', reversalStatus: 'NONE' });
    expect(a.upiRrn).toMatch(/^\d{12}$/);
    // Phase 2 fields are unchanged.
    expect(a).toMatchObject({ state: 'SUCCEEDED', amountPaise: rs(799), payerVpa: 'asha@okhdfc' });
  });

  it('shows exactly the customer-safe fields, via header or query token', async () => {
    const p = (await create('o2')).json();
    for (const via of ['header', 'query'] as const) {
      const res = await status(p.id, p.customerStatusToken, via);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(['amountPaise', 'message', 'paymentId', 'status', 'updatedAt']);
      expect(res.json()).toMatchObject({ paymentId: p.id, status: 'success', message: 'Payment successful.', amountPaise: rs(799) });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('tells the customer not to pay again while verification runs, and never calls the PSP', async () => {
    psp.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    const p = (await create('o3')).json();
    const calls = psp.calls.length;
    expect((await status(p.id, p.customerStatusToken)).json().status).toBe('processing');
    clock.advance(60_000);
    const verifying = (await status(p.id, p.customerStatusToken)).json();
    expect(verifying.status).toBe('verification_in_progress');
    expect(verifying.message).toMatch(/don't make another payment/);
    expect(psp.calls.length).toBe(calls);
  });

  it('reflects a bank auto-reversal once the poller observes it', async () => {
    psp.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' });
    psp.scriptNextInquiry([{ found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'INITIATED' } }]);
    const p = (await create('o4')).json();
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
    clock.set(t!.nextCheckAt!);
    await ctx.poller.runOnce();
    expect((await status(p.id, p.customerStatusToken)).json().status).toBe('refund_processing');
  });

  it('rejects missing, wrong and cross-payment tokens identically', async () => {
    const p1 = (await create('o5')).json();
    const p2 = (await create('o6')).json();
    for (const res of [
      await status(p1.id, undefined),
      await status(p1.id, 'not-a-token'),
      await status(p1.id, p2.customerStatusToken),
      await status('pay_doesnotexist', customerToken('s'.repeat(40), 'pay_doesnotexist')),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    }
  });

  it('cannot be used to reach merchant or dashboard APIs', async () => {
    const p = (await create('o7')).json();
    const asBearer = await app.inject({ method: 'GET', url: `/v1/payments/${p.id}`, headers: { authorization: `Bearer ${p.customerStatusToken}` } });
    expect(asBearer.statusCode).toBe(401);
    const asCookie = await app.inject({ method: 'GET', url: '/dashboard/api/me', headers: { cookie: `rs_session=${p.customerStatusToken}` } });
    expect(asCookie.statusCode).toBe(401);
  });

  it('answers CORS preflight for the token header', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/public/payments/pay_x/status' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe('x-payment-token');
  });
});
