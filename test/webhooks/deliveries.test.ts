import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { webhookDeliveryResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { verify } from '../../src/webhooks/sign.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';
const PW = 'correct horse battery';

describe('webhook deliveries', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let key: string;
  let secret: string;
  let failing: boolean;
  let sent: { headers: Record<string, string>; body: string }[];
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-20T14:00:00'));
    sent = [];
    failing = false;
    ctx = buildContext({
      db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 },
      fetchImpl: async (_url, init) => {
        sent.push({ headers: init.headers, body: init.body });
        return failing ? new Response('nope', { status: 500 }) : new Response('ok', { status: 200 });
      },
    });
    app = buildApp(ctx);
    const m = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Shop', webhookUrl: 'https://shop.example/hooks' } })).json();
    key = m.apiKey;
    secret = m.webhookSecret;
    for (const role of ['ADMIN', 'SUPPORT']) {
      const email = `${role.toLowerCase()}@shop.example`;
      await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${key}` }, payload: { email, name: role, password: PW, role } });
      const res = await app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email, password: PW } });
      cookies[role] = `rs_session=${res.cookies.find((c) => c.name === 'rs_session')!.value}`;
    }
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: object, apiKey = key) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${apiKey}` }, ...(payload ? { payload } : {}) });
  const pay = (ref: string) => call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okicici', idempotencyKey: ref });
  const deliveries = async (query = '') => (await call('GET', `/v1/webhook-deliveries${query}`)).json();

  it('lists deliveries newest first with their status, attempts and payload', async () => {
    await pay('o1');
    await pay('o2');
    let list = await deliveries();
    expect(list.data.map((d: { status: string }) => d.status)).toEqual(['pending', 'pending']);
    await ctx.dispatcher.runOnce();
    list = await deliveries();
    expect(list.data).toHaveLength(2);
    for (const d of list.data) webhookDeliveryResponse.parse(d);
    expect(list.data[0]).toMatchObject({ event: 'payment.succeeded', status: 'delivered', attempts: 1, lastError: null, data: { orderId: null } });
    expect(list.data[0].createdAt >= list.data[1].createdAt).toBe(true);
    expect((await deliveries('?status=failed')).data).toEqual([]);
    expect((await deliveries('?event=payment.failed')).data).toEqual([]);
    // Pagination by cursor.
    const first = await deliveries('?limit=1');
    expect(first.data).toHaveLength(1);
    expect(first.nextBefore).toBe(first.data[0].id);
    expect((await deliveries(`?limit=1&before=${first.nextBefore}`)).data[0].id).toBe(list.data[1].id);
  });

  it('shows failures with the last error, and a failed delivery can be redelivered', async () => {
    failing = true;
    await pay('o1');
    // Retry hourly (the backoff never waits longer) until Merchantflo gives up on it.
    for (let i = 0; i < 200 && (await deliveries('?status=failed')).data.length === 0; i++) {
      await ctx.dispatcher.runOnce();
      clock.advance(3_600_000);
    }
    const [dead] = (await deliveries('?status=failed')).data;
    expect(dead).toMatchObject({ status: 'failed', lastError: 'HTTP 500' });
    expect(dead.attempts).toBeGreaterThan(1);

    failing = false;
    const res = await call('POST', `/v1/webhook-deliveries/${dead.id}/redeliver`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: dead.id, status: 'pending', attempts: 0 });
    await ctx.dispatcher.runOnce();
    expect((await deliveries()).data[0]).toMatchObject({ id: dead.id, status: 'delivered' });
  });

  it('a redelivered webhook keeps its original id and is signed fresh (current time, current secret)', async () => {
    await pay('o1');
    await ctx.dispatcher.runOnce();
    const original = sent.at(-1)!;
    const id = JSON.parse(original.body).id;

    clock.advance(2 * 86_400_000);
    secret = (await call('POST', '/v1/merchants/me/webhook-secret/rotate')).json().webhookSecret;
    expect((await call('POST', `/v1/webhook-deliveries/${id}/redeliver`)).statusCode).toBe(202);
    await ctx.dispatcher.runOnce();
    const again = sent.at(-1)!;

    expect(JSON.parse(again.body)).toEqual(JSON.parse(original.body)); // same id, event, createdAt, data
    expect(again.headers['x-resilience-delivery']).toBe(id);
    const ts = Number(again.headers['x-resilience-timestamp']);
    expect(ts).toBe(Math.floor(clock.now().getTime() / 1000));
    expect(verify(secret, ts, again.body, again.headers['x-resilience-signature']!)).toBe(true);
  });

  it('refuses to redeliver one that is still queued, and hides other merchants’ deliveries', async () => {
    await pay('o1');
    const [pending] = (await deliveries()).data;
    const res = await call('POST', `/v1/webhook-deliveries/${pending.id}/redeliver`);
    expect(res.statusCode).toBe(409);

    const other = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Other' } })).json().apiKey;
    expect((await call('GET', '/v1/webhook-deliveries', undefined, other)).json().data).toEqual([]);
    expect((await call('POST', `/v1/webhook-deliveries/${pending.id}/redeliver`, undefined, other)).statusCode).toBe(404);
  });

  it('dashboard Developers data: admins only', async () => {
    await pay('o1');
    await ctx.dispatcher.runOnce();
    const get = (role: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookies[role]! } });
    const deliveriesRes = await get('ADMIN', '/dashboard/api/developers/webhook-deliveries');
    expect(deliveriesRes.statusCode).toBe(200);
    expect(deliveriesRes.json().data[0]).toMatchObject({ event: 'payment.succeeded', status: 'delivered' });
    const keys = (await get('ADMIN', '/dashboard/api/developers/api-keys')).json();
    expect(keys.data[0]).toMatchObject({ prefix: expect.stringMatching(/^sk_test_/), revokedAt: null });
    expect(JSON.stringify(keys)).not.toContain(key);
    const conns = (await get('ADMIN', '/dashboard/api/developers/psp-connections')).json();
    expect(conns.data).toEqual([]);
    const overview = (await get('ADMIN', '/dashboard/api/developers')).json();
    expect(overview).toMatchObject({ webhookUrl: 'https://shop.example/hooks', apiBase: expect.any(String) });

    const id = deliveriesRes.json().data[0].id;
    const redeliver = (role: string) =>
      app.inject({ method: 'POST', url: `/dashboard/api/developers/webhook-deliveries/${id}/redeliver`, headers: { cookie: cookies[role]!, 'x-dashboard-request': '1' } });
    expect((await redeliver('SUPPORT')).statusCode).toBe(403);
    expect((await get('SUPPORT', '/dashboard/api/developers/api-keys')).statusCode).toBe(403);
    expect((await redeliver('ADMIN')).statusCode).toBe(202);
  });
});
