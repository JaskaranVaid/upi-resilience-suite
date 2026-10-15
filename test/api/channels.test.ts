import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentTracking } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('payment channels', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let collectOnly: MockPsp;
  let full: MockPsp;
  let key: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    collectOnly = new MockPsp('collectOnly', { capabilities: { channels: ['UPI_COLLECT'] } });
    full = new MockPsp('full');
    ctx = buildContext({ db, adapters: [collectOnly, full], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    key = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Shop' } })).json().apiKey;
  });

  const pay = (payload: object) => app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${key}` }, payload });

  it('returns a UPI intent deeplink for an intent payment, only from a PSP that supports intent', async () => {
    const res = await pay({ amountPaise: rs(2500), idempotencyKey: 'i1', channel: 'UPI_INTENT', orderId: 'ORD-1' });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ state: 'PENDING', channel: 'UPI_INTENT', pspId: 'full', payerVpa: null });
    expect(p.customerAction).toMatchObject({ type: 'UPI_INTENT', url: expect.stringMatching(/^upi:\/\/pay\?/) });
    expect(collectOnly.calls).toHaveLength(0);
  });

  it('defaults to UPI intent without a VPA and to collect with one', async () => {
    expect((await pay({ amountPaise: rs(100), idempotencyKey: 'd1' })).json().channel).toBe('UPI_INTENT');
    expect((await pay({ amountPaise: rs(100), idempotencyKey: 'd2', payerVpa: 'asha@okhdfc' })).json().channel).toBe('UPI_COLLECT');
    const missing = await pay({ amountPaise: rs(100), idempotencyKey: 'd3', channel: 'UPI_COLLECT' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toMatch(/payerVpa is required/);
  });

  it('hands back the same deeplink on an idempotent replay, without a second PSP request', async () => {
    const first = (await pay({ amountPaise: rs(2500), idempotencyKey: 'same', channel: 'UPI_QR' })).json();
    const again = await pay({ amountPaise: rs(2500), idempotencyKey: 'same', channel: 'UPI_QR' });
    expect(again.statusCode).toBe(200);
    expect(again.json().customerAction).toEqual(first.customerAction);
    expect(first.customerAction).toMatchObject({ type: 'UPI_QR', qrData: expect.stringMatching(/^upi:\/\/pay/) });
    expect(full.calls.filter((c) => c.op === 'collect')).toHaveLength(1);
  });

  it('netbanking redirects to the chosen bank, or opens the PSP checkout when no bank is given; cards use the PSP checkout', async () => {
    expect((await pay({ amountPaise: rs(5000), idempotencyKey: 'nb1', channel: 'NETBANKING', netbankingBankCode: '3021' })).json().customerAction.type).toBe('REDIRECT');
    expect((await pay({ amountPaise: rs(5000), idempotencyKey: 'nb2', channel: 'NETBANKING' })).json().customerAction.type).toBe('PSP_CHECKOUT');
    const card = (await pay({ amountPaise: rs(5000), idempotencyKey: 'c1', channel: 'CARD' })).json();
    expect(card.customerAction).toMatchObject({ type: 'PSP_CHECKOUT', provider: 'mock' });
  });

  it('a merchant with no PSP for the channel gets NO_PSP_CONNECTED', async () => {
    const { db } = await freshDb();
    const c2 = buildContext({ db, adapters: [new MockPsp('only', { capabilities: { channels: ['UPI_COLLECT'] } })], adminToken: ADMIN, clock, sleep: clock.sleep });
    const app2 = buildApp(c2);
    const k = (await app2.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'S' } })).json().apiKey;
    const res = await app2.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${k}` }, payload: { amountPaise: 100, idempotencyKey: 'x', channel: 'CARD' } });
    expect(res.json().error).toMatchObject({ code: 'NO_PSP_CONNECTED', message: expect.stringMatching(/CARD/) });
  });

  it('the poller confirms an intent payment once the customer has paid, and the action is no longer shown', async () => {
    const p = (await pay({ amountPaise: rs(2500), idempotencyKey: 'paid', channel: 'UPI_INTENT' })).json();
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, p.id));
    clock.set(t!.nextCheckAt!);
    await ctx.poller.runOnce();
    const after = (await app.inject({ method: 'GET', url: `/v1/payments/${p.id}`, headers: { authorization: `Bearer ${key}` } })).json();
    expect(after).toMatchObject({ state: 'SUCCEEDED', customerAction: null, capture: 'CAPTURED' });
  });
});
