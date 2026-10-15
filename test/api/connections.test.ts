import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentTracking, pspConnections } from '../../src/db/schema.js';
import { connectionAdapterFactory } from '../../src/psp/connections.js';
import type { FetchFn } from '../../src/psp/http.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';
/** Key pairs the fake Cashfree accepts. */
const ACCOUNTS: Record<string, string> = { CF_MERCHANT_A: 'secret-a-0001', CF_MERCHANT_B: 'secret-b-0002' };

describe('PSP connections API', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  const seen: Array<{ clientId: string; path: string }> = [];

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    seen.length = 0;
    const fetchFn: FetchFn = async (url, init) => {
      const clientId = init.headers['x-client-id']!;
      const path = new URL(url).pathname.replace(/^\/pg/, '');
      seen.push({ clientId, path });
      const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body), headers: { get: () => null } });
      if (ACCOUNTS[clientId] !== init.headers['x-client-secret']) return reply(401, { message: 'authentication Failed' });
      if (init.method === 'POST' && path === '/orders') return reply(200, { payment_session_id: 'sess' });
      if (init.method === 'POST' && path === '/orders/sessions') return reply(200, { action: 'custom' });
      if (init.method === 'GET' && /\/payments$/.test(path)) return reply(200, [{ payment_status: 'PENDING' }]);
      if (init.method === 'GET' && /\/refunds$/.test(path)) return reply(200, []);
      return reply(404, { message: 'order not found' });
    };
    ctx = buildContext({
      db,
      adapters: [],
      adminToken: ADMIN,
      clock,
      sleep: clock.sleep,
      connectionAdapters: connectionAdapterFactory({ fetch: fetchFn }),
      publicBaseUrl: 'https://api.merchantflo.example',
    });
    app = buildApp(ctx);
  });

  const onboard = async (mode: 'TEST' | 'LIVE') =>
    (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: `${mode} Co`, mode } })).json().apiKey as string;
  const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${key}` } });
  const connectCashfree = (key: string, clientId: string, clientSecret: string, environment?: string) =>
    call(key, 'POST', '/v1/psp-connections', { provider: 'cashfree', credentials: { clientId, clientSecret }, ...(environment ? { environment } : {}) });

  it("checks the credentials with the PSP, stores them sealed, and never returns them", async () => {
    const key = await onboard('LIVE');
    const res = await connectCashfree(key, 'CF_MERCHANT_A', ACCOUNTS.CF_MERCHANT_A!);
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ provider: 'cashfree', environment: 'production', status: 'ACTIVE', credentialHint: 'CF_M…NT_A' });
    expect(c.webhookUrl).toBe(`https://api.merchantflo.example/webhooks/psp/${c.id}`);
    expect(seen).toEqual([{ clientId: 'CF_MERCHANT_A', path: expect.stringMatching(/^\/orders\/mf-credential-check-/) }]);
    const [row] = await ctx.db.select().from(pspConnections).where(eq(pspConnections.id, c.id));
    expect(row!.credentialsSealed).not.toContain(ACCOUNTS.CF_MERCHANT_A);
    const list = await call(key, 'GET', '/v1/psp-connections');
    expect(JSON.stringify(list.json())).not.toContain(ACCOUNTS.CF_MERCHANT_A);
  });

  it('rejects credentials the PSP refuses, and saves nothing', async () => {
    const key = await onboard('LIVE');
    const res = await connectCashfree(key, 'CF_MERCHANT_A', 'wrong-secret');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'PSP_CREDENTIALS_REJECTED' });
    expect(await ctx.db.select().from(pspConnections)).toEqual([]);
  });

  it('matches the environment to the merchant mode, and keeps mocks to test mode', async () => {
    const live = await onboard('LIVE');
    expect((await connectCashfree(live, 'CF_MERCHANT_A', ACCOUNTS.CF_MERCHANT_A!, 'sandbox')).json().error.message).toMatch(/only connect production/);
    expect((await call(live, 'POST', '/v1/psp-connections', { provider: 'mock' })).statusCode).toBe(400);
    const test = await onboard('TEST');
    expect((await connectCashfree(test, 'CF_MERCHANT_A', ACCOUNTS.CF_MERCHANT_A!, 'production')).json().error.message).toMatch(/only connect sandbox/);
    const mock = await call(test, 'POST', '/v1/psp-connections', { provider: 'mock' });
    expect(mock.json()).toMatchObject({ provider: 'mock', environment: 'sandbox' });
  });

  it('rotates credentials (checked first) and disables a connection', async () => {
    const key = await onboard('LIVE');
    const c = (await connectCashfree(key, 'CF_MERCHANT_A', ACCOUNTS.CF_MERCHANT_A!)).json();
    const bad = await call(key, 'PATCH', `/v1/psp-connections/${c.id}`, { credentials: { clientId: 'CF_MERCHANT_A', clientSecret: 'nope' } });
    expect(bad.statusCode).toBe(422);
    const rotated = await call(key, 'PATCH', `/v1/psp-connections/${c.id}`, { credentials: { clientId: 'CF_MERCHANT_B', clientSecret: ACCOUNTS.CF_MERCHANT_B! } });
    expect(rotated.json().credentialHint).toBe('CF_M…NT_B');
    // The cached adapter was replaced: the next payment goes out with the new account's keys.
    seen.length = 0;
    await call(key, 'POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ab@okaxis', idempotencyKey: 'p1', customerPhone: '9876543210' });
    expect(new Set(seen.map((s) => s.clientId))).toEqual(new Set(['CF_MERCHANT_B']));

    await call(key, 'PATCH', `/v1/psp-connections/${c.id}`, { status: 'DISABLED' });
    const pay = await call(key, 'POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ab@okaxis', idempotencyKey: 'p2', customerPhone: '9876543210' });
    expect(pay.json().error.code).toBe('NO_PSP_CONNECTED');
  });

  it("can't read or change another merchant's connection", async () => {
    const a = await onboard('LIVE');
    const b = await onboard('LIVE');
    const c = (await connectCashfree(a, 'CF_MERCHANT_A', ACCOUNTS.CF_MERCHANT_A!)).json();
    expect((await call(b, 'PATCH', `/v1/psp-connections/${c.id}`, { status: 'DISABLED' })).statusCode).toBe(404);
    expect((await call(b, 'GET', '/v1/psp-connections')).json().data).toEqual([]);
  });

  it("verifies each connection's webhooks with that connection's own secret", async () => {
    const a = await onboard('LIVE');
    const b = await onboard('LIVE');
    const ca = (await connectCashfree(a, 'CF_MERCHANT_A', ACCOUNTS.CF_MERCHANT_A!)).json();
    const cb = (await connectCashfree(b, 'CF_MERCHANT_B', ACCOUNTS.CF_MERCHANT_B!)).json();
    const pay = (await call(a, 'POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ab@okaxis', idempotencyKey: 'p1', customerPhone: '9876543210' })).json();
    const [t] = await ctx.db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, pay.id));

    const raw = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: t!.txnRef } } });
    const ts = String(clock.now().getTime());
    const signedBy = (secret: string) => ({
      'content-type': 'application/json',
      'x-webhook-timestamp': ts,
      'x-webhook-signature': createHmac('sha256', secret).update(ts + raw).digest('base64'),
    });
    const toA = await app.inject({ method: 'POST', url: ca.webhookUrl.replace('https://api.merchantflo.example', ''), payload: raw, headers: signedBy(ACCOUNTS.CF_MERCHANT_A!) });
    expect(toA.json()).toEqual({ received: true, matched: 1 });
    // Merchant A's signature is worthless at merchant B's webhook URL.
    const toB = await app.inject({ method: 'POST', url: `/webhooks/psp/${cb.id}`, payload: raw, headers: signedBy(ACCOUNTS.CF_MERCHANT_A!) });
    expect(toB.statusCode).toBe(401);
  });
});
