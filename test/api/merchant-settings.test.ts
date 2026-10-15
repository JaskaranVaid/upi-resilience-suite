import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { enqueueWebhook } from '../../src/webhooks/outbox.js';
import { verify } from '../../src/webhooks/sign.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('merchant settings', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  const sent: Array<{ headers: Record<string, string>; body: string }> = [];
  let key: string;
  let merchantId: string;
  let secret: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    sent.length = 0;
    ctx = buildContext({
      db,
      adapters: [new MockPsp('pspA')],
      adminToken: ADMIN,
      clock,
      sleep: clock.sleep,
      webhookTargets: 'public-only',
      resolveHost: async () => ['13.234.10.1'],
      fetchImpl: async (_url, init) => {
        sent.push({ headers: init.headers, body: init.body });
        return { ok: true, status: 200 };
      },
    });
    app = buildApp(ctx);
    const r = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Shop', webhookUrl: 'https://hooks.shop.example/upi' } })).json();
    key = r.apiKey;
    merchantId = r.merchant.id;
    secret = r.webhookSecret;
  });

  const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/v1/merchants/me', headers: { authorization: `Bearer ${key}` }, payload });

  it('updates settings, merging steering and replacing method costs', async () => {
    const res = await patch({ name: 'Shop India', steering: { shareBps: 5000 }, methodCosts: { CARD: { percentBps: 150, flatPaise: 0 } }, category: 'EXEMPT_SECTOR' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Shop India', category: 'EXEMPT_SECTOR', methodCosts: { CARD: { percentBps: 150, flatPaise: 0 } } });
    expect(res.json().steering).toMatchObject({ enabled: true, shareBps: 5000, minSavingsPaise: rs(5) });
  });

  it('validates the webhook URL policy, refuses mode changes, and allows clearing the URL', async () => {
    expect((await patch({ webhookUrl: 'http://hooks.shop.example/upi' })).json().error.message).toMatch(/https/);
    expect((await patch({ webhookUrl: 'https://169.254.169.254/x' })).statusCode).toBe(400);
    expect((await patch({ mode: 'LIVE' })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ webhookUrl: null })).json().webhookUrl).toBeNull();
  });

  it('rotates the webhook signing secret: deliveries from then on verify only with the new one', async () => {
    const rotated = await app.inject({ method: 'POST', url: '/v1/merchants/me/webhook-secret/rotate', headers: { authorization: `Bearer ${key}` } });
    const fresh = rotated.json().webhookSecret as string;
    expect(fresh).toMatch(/^whsec_/);
    expect(fresh).not.toBe(secret);
    await enqueueWebhook(ctx.db, { merchantId, event: 'payment.succeeded', payload: { id: 'pay_1' }, now: clock.now() });
    await ctx.dispatcher.runOnce();
    const { headers, body } = sent.at(-1)!;
    const ts = Number(headers['x-resilience-timestamp']);
    expect(verify(fresh, ts, body, headers['x-resilience-signature']!)).toBe(true);
    expect(verify(secret, ts, body, headers['x-resilience-signature']!)).toBe(false);
  });
});
