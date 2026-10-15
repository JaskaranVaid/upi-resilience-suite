import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { payments, paymentTracking, savingsEvents } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('checkout sessions', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let psp: MockPsp;
  let key: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    psp = new MockPsp('pspA');
    ctx = buildContext({ db, adapters: [psp], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    key = (
      await app.inject({
        method: 'POST',
        url: '/v1/merchants',
        headers: { authorization: `Bearer ${ADMIN}` },
        payload: { name: 'Shop', methodCosts: { NETBANKING: { percentBps: 0, flatPaise: rs(8) }, CARD: { percentBps: 180, flatPaise: 0 } } },
      })
    ).json().apiKey;
  });

  const createSession = (payload: object = { amountPaise: rs(5000), orderId: 'ORD-1', customer: { phone: '9876543210' } }) =>
    app.inject({ method: 'POST', url: '/v1/checkout/sessions', headers: { authorization: `Bearer ${key}` }, payload });
  const pub = (method: 'GET' | 'POST', path: string, token: string, payload?: object) =>
    app.inject({ method, url: `/public/checkout/sessions/${path}`, headers: { 'x-checkout-token': token }, ...(payload ? { payload } : {}) });
  const poll = async (paymentId: string) => {
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, paymentId));
    clock.set(t!.nextCheckAt!);
    await ctx.poller.runOnce();
  };

  it('shows each method with its payable amount and the recommended (discounted) one', async () => {
    const res = await createSession();
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.clientToken).toEqual(expect.any(String));
    expect(s.status).toBe('OPEN');
    expect(s.methods).toEqual([
      { method: 'UPI', payablePaise: rs(5000), discountPaise: 0, recommended: false, upiFlows: ['INTENT', 'QR', 'COLLECT'] },
      { method: 'NETBANKING', payablePaise: rs(4997), discountPaise: rs(3), recommended: true },
      { method: 'CARD', payablePaise: rs(5000), discountPaise: 0, recommended: false },
    ]);
    // The browser sees the same view with the session token, and nothing with a wrong one.
    expect((await pub('GET', s.id, s.clientToken)).json().methods).toHaveLength(3);
    expect((await pub('GET', s.id, 'wrong')).statusCode).toBe(404);
  });

  it('charges the discounted amount for the steered method and books the saving once, when the payment succeeds', async () => {
    const s = (await createSession()).json();
    const paid = (await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'NETBANKING' })).json().payment;
    expect(paid).toMatchObject({ method: 'NETBANKING', amountPaise: rs(4997), status: 'processing', action: { type: 'PSP_CHECKOUT' } });
    expect(await ctx.db.select().from(savingsEvents).where(eq(savingsEvents.type, 'MDR_STEERING_ACCEPTED'))).toEqual([]);

    await poll(paid.id); // the customer completed the bank payment
    const status = (await pub('GET', `${s.id}/status`, s.clientToken)).json();
    expect(status).toMatchObject({ status: 'PAID', payment: { status: 'success', action: null } });
    const booked = await ctx.db.select().from(savingsEvents).where(eq(savingsEvents.type, 'MDR_STEERING_ACCEPTED'));
    expect(booked.map((b) => b.amountPaise)).toEqual([rs(9)]);
    expect((await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI' })).statusCode).toBe(409);
  });

  it('never starts a second payment while one is live — including two clicks at once', async () => {
    const s = (await createSession()).json();
    const [a, b] = await Promise.all([pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI' }), pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI' })]);
    const ok = [a, b].filter((r) => r.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) expect([200, 409]).toContain(r.statusCode);
    const again = (await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'CARD' })).json().payment;
    expect(again.channel).toBe('UPI_INTENT'); // the live UPI payment stands
    expect(await ctx.db.select().from(payments)).toHaveLength(1);
  });

  it('lets the customer try again after a failed payment', async () => {
    psp.enqueue({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
    const s = (await createSession()).json();
    const first = (await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI', upiFlow: 'COLLECT', vpa: 'asha@okhdfc' })).json().payment;
    expect(first.status).toBe('failed');
    const second = (await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI' })).json().payment;
    expect(second.id).not.toBe(first.id);
    expect(await ctx.db.select().from(payments)).toHaveLength(2);
  });

  it('serves the UPI QR as an SVG image', async () => {
    const s = (await createSession()).json();
    await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI', upiFlow: 'QR' });
    const img = await app.inject({ method: 'GET', url: `/public/checkout/sessions/${s.id}/qr.svg?token=${encodeURIComponent(s.clientToken)}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/svg+xml');
    expect(img.body).toMatch(/^<svg/);
  });

  it("refuses an expired session and another session's token", async () => {
    const s = (await createSession({ amountPaise: rs(100), expiresInMinutes: 5 })).json();
    const other = (await createSession({ amountPaise: rs(100) })).json();
    expect((await pub('GET', other.id, s.clientToken)).statusCode).toBe(404);
    clock.advance(6 * 60_000);
    const late = await pub('POST', `${s.id}/pay`, s.clientToken, { method: 'UPI' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/expired/);
  });

  it('answers the CORS preflight and replays a create with the same idempotency key', async () => {
    const pre = await app.inject({ method: 'OPTIONS', url: '/public/checkout/sessions/x/pay' });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('x-checkout-token');
    const a = await createSession({ amountPaise: rs(100), idempotencyKey: 'cart-9' });
    const b = await createSession({ amountPaise: rs(100), idempotencyKey: 'cart-9' });
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
  });

  it('takes only an http(s) returnUrl (the widget sends the customer there)', async () => {
    expect((await createSession({ amountPaise: rs(100), returnUrl: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await createSession({ amountPaise: rs(100), returnUrl: 'data:text/html,hi' })).statusCode).toBe(400);
    expect((await createSession({ amountPaise: rs(100), returnUrl: 'http://localhost:4000/done' })).statusCode).toBe(201);
  });
});
