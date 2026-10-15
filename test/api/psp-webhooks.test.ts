import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { payments, paymentTracking } from '../../src/db/schema.js';
import { CashfreeAdapter } from '../../src/psp/cashfree/adapter.js';
import type { FetchFn } from '../../src/psp/http.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs, seedMerchant } from '../helpers/fixtures.js';

const SECRET = 'cfsk_test_secret_value';

describe('PSP webhooks (Cashfree, against a fake API)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let merchantId: string;
  /** What the fake Cashfree reports for each order. */
  const orderPayments = new Map<string, unknown[]>();
  let lookups = 0;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    orderPayments.clear();
    lookups = 0;
    const fetchFn: FetchFn = async (url, init) => {
      const path = new URL(url).pathname.replace(/^\/pg/, '');
      let status = 200;
      let body: unknown = {};
      if (init.method === 'POST' && path === '/orders') body = { payment_session_id: 'sess' };
      else if (init.method === 'POST' && path === '/orders/sessions') body = { action: 'custom' };
      else if (init.method === 'GET' && /^\/orders\/[^/]+\/payments$/.test(path)) {
        lookups++;
        body = orderPayments.get(path.split('/')[2]!) ?? [{ payment_status: 'PENDING' }];
      } else if (init.method === 'GET' && /\/refunds$/.test(path)) body = [];
      else status = 404;
      const text = JSON.stringify(body);
      return { status, text: async () => text, headers: { get: () => null } };
    };
    const cashfree = new CashfreeAdapter({ clientId: 'CF_APP', clientSecret: SECRET, env: 'sandbox', fetch: fetchFn, log: () => {} });
    ctx = buildContext({ db, adapters: [cashfree, new MockPsp('pspMock')], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    merchantId = (await seedMerchant(db)).id;
  });

  const signed = (body: unknown, at = clock.now().getTime()) => {
    const raw = JSON.stringify(body);
    const ts = String(at);
    return { payload: raw, headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': createHmac('sha256', SECRET).update(ts + raw).digest('base64') } };
  };
  const post = (pspId: string, s: { payload: string; headers: Record<string, string> }) => app.inject({ method: 'POST', url: `/webhooks/psp/${pspId}`, ...s });
  const collect = async () => {
    const { payment } = await ctx.payments.create(merchantId, { amountPaise: rs(2500), payerVpa: 'asha@okhdfc', idempotencyKey: `k${Math.random()}`, customerPhone: '9876543210' });
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, payment.id));
    return { payment, txnRef: t!.txnRef!, pspId: t!.pspId! };
  };

  it('POST /v1/payments requires the customer phone Cashfree needs, and passes it through', async () => {
    const m = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${'x'.repeat(20)}` }, payload: { name: 'Shop' } });
    const auth = { authorization: `Bearer ${m.json().apiKey}` };
    const missing = await app.inject({ method: 'POST', url: '/v1/payments', headers: auth, payload: { amountPaise: rs(100), payerVpa: 'asha@okhdfc', idempotencyKey: 'o1' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toMatch(/customerPhone is required by the payment provider \(cashfree\)/);
    const bad = await app.inject({ method: 'POST', url: '/v1/payments', headers: auth, payload: { amountPaise: rs(100), payerVpa: 'asha@okhdfc', idempotencyKey: 'o2', customerPhone: '123' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/v1/payments', headers: auth, payload: { amountPaise: rs(100), payerVpa: 'asha@okhdfc', idempotencyKey: 'o3', customerPhone: '9876543210' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ state: 'PENDING', merchantStatus: 'PROCESSING' });
  });

  it('a Cashfree collect starts pending while the customer approves', async () => {
    const { payment, pspId } = await collect();
    expect(payment.state).toBe('PENDING');
    expect(pspId).toBe('cashfree');
  });

  it('a signed webhook triggers an immediate check; state comes from the API, not the payload', async () => {
    const { payment, txnRef } = await collect();
    orderPayments.set(txnRef, [{ payment_status: 'SUCCESS', cf_payment_id: 77, bank_reference: '612345678901' }]);
    const res = await post('cashfree', signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: txnRef }, payment: { payment_status: 'SUCCESS' } } }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, matched: 1 });
    const [p] = await ctx.db.select().from(payments).where(eq(payments.id, payment.id));
    expect(p).toMatchObject({ state: 'SUCCEEDED', pspTxnId: '77' }); // Cashfree's payment id: what its settlement report refers to
  });

  it('a webhook that claims success while the API still says pending changes nothing', async () => {
    const { payment, txnRef } = await collect();
    const before = lookups;
    await post('cashfree', signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: txnRef } } }));
    expect(lookups).toBeGreaterThan(before); // we looked it up ourselves…
    const [p] = await ctx.db.select().from(payments).where(eq(payments.id, payment.id));
    expect(p!.state).toBe('PENDING'); // …and believed the API, not the webhook
  });

  it('rejects bad signatures and replays without touching anything', async () => {
    const { txnRef } = await collect();
    orderPayments.set(txnRef, [{ payment_status: 'SUCCESS' }]);
    const good = signed({ data: { order: { order_id: txnRef } } });
    const tampered = { ...good, payload: good.payload.replace(txnRef, 'pay_other-1') };
    expect((await post('cashfree', tampered)).statusCode).toBe(401);
    const stale = signed({ data: { order: { order_id: txnRef } } }, clock.now().getTime() - 10 * 60_000);
    expect((await post('cashfree', stale)).statusCode).toBe(401);
    expect((await post('cashfree', { payload: good.payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect(lookups).toBe(0);
  });

  it('acknowledges genuine webhooks about things we do not track', async () => {
    const res = await post('cashfree', signed({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'someone_elses_order' } } }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, matched: 0 });
  });

  it('404s for unknown providers and providers without webhooks', async () => {
    expect((await post('nope', signed({}))).statusCode).toBe(404);
    expect((await post('pspMock', signed({}))).statusCode).toBe(404);
  });
});
