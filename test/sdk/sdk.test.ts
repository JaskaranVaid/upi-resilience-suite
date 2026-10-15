import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { buildApp } from '../../src/api/app.js';
import type { checkoutSessionResponse, debitResponse, mandateResponse, paymentResponse, webhookDeliveryResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { sign } from '../../src/webhooks/sign.js';
import { Merchantflo, MerchantfloError, type CheckoutSession, type Debit, type Mandate, type Payment, type WebhookDelivery } from '../../sdk/node/src/index.js';
import { verifyWebhook, WebhookVerificationError } from '../../sdk/node/src/webhooks.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

// Compile-time contract: what the API documents is assignable to what the SDK promises.
type Assignable<To, From extends To> = From;
export type SdkContract = [
  Assignable<Payment, z.output<typeof paymentResponse>>,
  Assignable<CheckoutSession, z.output<typeof checkoutSessionResponse>>,
  Assignable<Mandate, z.output<typeof mandateResponse>>,
  Assignable<Debit, z.output<typeof debitResponse>>,
  Assignable<WebhookDelivery, z.output<typeof webhookDeliveryResponse>>,
];

const ADMIN = 'test-admin-token';
const BASE = 'https://api.merchantflo.test';

/** A fetch that serves requests from the app in-process. */
function injectFetch(app: FastifyInstance, log: { method: string; url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    log.push({ method: init.method ?? 'GET', url: u.pathname + u.search, headers });
    const res = await app.inject({ method: (init.method ?? 'GET') as 'GET', url: u.pathname + u.search, headers, ...(init.body ? { payload: String(init.body) } : {}) });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out.set(k, v);
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: out });
  }) as typeof fetch;
}

describe('Node SDK', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let apiKey: string;
  let webhookSecret: string;
  let sdk: Merchantflo;
  let log: { method: string; url: string; headers: Record<string, string> }[];
  let delivered: { headers: Record<string, string>; body: string }[];

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-20T14:00:00'));
    delivered = [];
    ctx = buildContext({
      db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 },
      fetchImpl: async (_url, init) => {
        delivered.push({ headers: init.headers, body: init.body });
        return new Response('ok', { status: 200 });
      },
    });
    app = buildApp(ctx);
    const m = (
      await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Shop', webhookUrl: 'https://shop.example/hooks' } })
    ).json();
    apiKey = m.apiKey;
    webhookSecret = m.webhookSecret;
    log = [];
    sdk = new Merchantflo({ apiKey, baseUrl: BASE, fetch: injectFetch(app, log) });
  });

  it('creates and retrieves a checkout session', async () => {
    const s = await sdk.checkout.sessions.create({ amountPaise: rs(2500), orderId: 'ORD-1' });
    expect(s.clientToken).toEqual(expect.any(String));
    expect(s.methods[0]!.method).toBe('UPI');
    expect((await sdk.checkout.sessions.retrieve(s.id)).id).toBe(s.id);
    expect(log[0]).toMatchObject({ method: 'POST', url: '/v1/checkout/sessions', headers: { authorization: `Bearer ${apiKey}` } });
    expect(log[0]!.headers['user-agent']).toMatch(/^merchantflo-node\//);
  });

  it('sends the idempotency key as a header, so a replay returns the same payment', async () => {
    const a = await sdk.payments.create({ amountPaise: rs(100), payerVpa: 'ravi@okicici' }, { idempotencyKey: 'ord-1' });
    const b = await sdk.payments.create({ amountPaise: rs(100), payerVpa: 'ravi@okicici' }, { idempotencyKey: 'ord-1' });
    expect(b.id).toBe(a.id);
    expect(log[0]!.headers['idempotency-key']).toBe('ord-1');
    expect((await sdk.payments.retrieve(a.id)).state).toBe('SUCCEEDED');
  });

  it('covers AutoPay: mandate, debit request, retrieve and list', async () => {
    const mandate = await sdk.mandates.create({ mandateRef: 'UMN-1', customerVpa: 'ravi@okicici', maxAmountPaise: rs(1000) });
    const debit = await sdk.debits.create(mandate.id, { amountPaise: rs(499) }, { idempotencyKey: 'inv-1' });
    expect(debit.state).toBe('SCHEDULED');
    expect((await sdk.debits.retrieve(debit.id)).id).toBe(debit.id);
    expect((await sdk.debits.list({ state: 'SCHEDULED' })).data.map((d) => d.id)).toEqual([debit.id]);
    expect((await sdk.mandates.revoke(mandate.id)).status).toBe('REVOKED');
    expect(log.find((l) => l.url.startsWith('/v1/debits?'))!.url).toBe('/v1/debits?state=SCHEDULED');
  });

  it('throws MerchantfloError with the API error code and HTTP status', async () => {
    const bad = new Merchantflo({ apiKey: 'sk_test_nope', baseUrl: BASE, fetch: injectFetch(app) });
    await expect(bad.payments.retrieve('pay_x')).rejects.toMatchObject({ name: 'MerchantfloError', status: 401, code: 'UNAUTHORIZED' });
    const err = await sdk.payments.create({ amountPaise: -1 }, { idempotencyKey: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MerchantfloError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION', message: expect.stringContaining('amountPaise') });
  });

  it('retries reads and idempotent writes on network errors and 5xx, never other writes', async () => {
    let calls = 0;
    const flaky = (fail: number) =>
      (async (input: string | URL, init?: RequestInit) => {
        if (++calls <= fail) throw new TypeError('fetch failed');
        return injectFetch(app)(input, init);
      }) as typeof fetch;
    const client = (fail: number) => new Merchantflo({ apiKey, baseUrl: BASE, fetch: flaky(fail), retryDelayMs: 0 });

    const s = await sdk.checkout.sessions.create({ amountPaise: rs(500) });
    calls = 0;
    expect((await client(2).checkout.sessions.retrieve(s.id)).id).toBe(s.id);
    expect(calls).toBe(3);

    calls = 0;
    expect((await client(1).payments.create({ amountPaise: rs(100), payerVpa: 'asha@ok' }, { idempotencyKey: 'k1' })).state).toBe('SUCCEEDED');
    expect(calls).toBe(2);

    calls = 0;
    await expect(client(1).mandates.create({ mandateRef: 'UMN-9', customerVpa: 'asha@ok', maxAmountPaise: rs(10) })).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);

    calls = 0;
    await expect(client(5).checkout.sessions.retrieve(s.id)).rejects.toThrow('fetch failed');
    expect(calls).toBe(3); // 1 + maxRetries (2)
  });

  describe('verifyWebhook', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'whk_1', event: 'payment.succeeded', createdAt: '2026-10-20T08:30:00.000Z', data: { paymentId: 'pay_1' } });
    const now = 1_792_000_000;
    const headers = (ts = now, sig = sign(secret, ts, body)) => ({
      'x-resilience-event': 'payment.succeeded', 'x-resilience-delivery': 'whk_1', 'x-resilience-timestamp': String(ts), 'x-resilience-signature': sig,
    });

    it('returns the parsed event for a valid signature (string or Buffer body, any header casing)', () => {
      expect(verifyWebhook({ payload: body, headers: headers(), secret, now })).toMatchObject({ id: 'whk_1', event: 'payment.succeeded', data: { paymentId: 'pay_1' } });
      const upper = Object.fromEntries(Object.entries(headers()).map(([k, v]) => [k.toUpperCase(), v]));
      expect(verifyWebhook({ payload: Buffer.from(body), headers: upper, secret, now }).id).toBe('whk_1');
      expect(verifyWebhook({ payload: body, headers: new Headers(headers()), secret, now }).id).toBe('whk_1');
    });

    it('rejects a wrong secret, a changed body, missing headers and a stale or future timestamp', () => {
      const fails = (f: () => unknown, reason: string) => expect(f).toThrow(new WebhookVerificationError(reason));
      fails(() => verifyWebhook({ payload: body, headers: headers(), secret: 'whsec_other', now }), 'Signature does not match');
      fails(() => verifyWebhook({ payload: body.replace('pay_1', 'pay_2'), headers: headers(), secret, now }), 'Signature does not match');
      fails(() => verifyWebhook({ payload: body, headers: { 'x-resilience-timestamp': String(now) }, secret, now }), 'Missing x-resilience-signature header');
      fails(() => verifyWebhook({ payload: body, headers: headers(now - 301), secret, now }), 'Timestamp outside the tolerance');
      fails(() => verifyWebhook({ payload: body, headers: headers(now + 301), secret, now }), 'Timestamp outside the tolerance');
      expect(verifyWebhook({ payload: body, headers: headers(now - 600), secret, now, toleranceSeconds: 900 }).id).toBe('whk_1');
    });

    it('verifies a real delivery from the dispatcher', async () => {
      await sdk.payments.create({ amountPaise: rs(100), payerVpa: 'ravi@okicici' }, { idempotencyKey: 'w1' });
      await ctx.dispatcher.runOnce();
      expect(delivered.length).toBeGreaterThan(0);
      const d = delivered[0]!;
      const event = verifyWebhook({ payload: d.body, headers: d.headers, secret: webhookSecret, now: clock.now().getTime() / 1000 });
      expect(event.event).toBe('payment.succeeded');

      // The delivery log shows it, and a redelivery re-sends the same id.
      const { data } = await sdk.webhookDeliveries.list({ status: 'delivered' });
      expect(data.map((x) => x.id)).toEqual([event.id]);
      expect((await sdk.webhookDeliveries.redeliver(event.id)).status).toBe('pending');
      await ctx.dispatcher.runOnce();
      expect(JSON.parse(delivered.at(-1)!.body).id).toBe(event.id);
    });
  });
});
