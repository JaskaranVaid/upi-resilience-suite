import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, mandates, pspConnections, type PspEnvironment } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('per-merchant PSP routing', () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let shared: MockPsp;

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    shared = new MockPsp('platform-mock');
    ctx = buildContext({ db, adapters: [shared], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
  });

  const onboard = async (mode: 'TEST' | 'LIVE') => {
    const r = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: `${mode} Co`, mode } })).json();
    return { id: r.merchant.id as string, key: r.apiKey as string };
  };
  const connect = async (merchantId: string, environment: PspEnvironment, over: Partial<typeof pspConnections.$inferInsert> = {}) => {
    const [c] = await ctx.db
      .insert(pspConnections)
      .values({ id: newId('con'), merchantId, provider: 'mock', label: 'Own account', environment, ...over })
      .returning();
    return c!;
  };
  const call = (key: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${key}` } });

  it('test-mode merchants route through their sandbox connections, then shared adapters', async () => {
    const m = await onboard('TEST');
    const own = await connect(m.id, 'sandbox', { priority: 10 });
    await connect(m.id, 'production'); // never for a test merchant
    expect(await ctx.psps.idsFor(m.id)).toEqual([own.id, 'platform-mock']);
  });

  it('live merchants route only through their own production connections — never shared or sandbox ones', async () => {
    const m = await onboard('LIVE');
    await connect(m.id, 'sandbox');
    const prod = await connect(m.id, 'production');
    expect(await ctx.psps.idsFor(m.id)).toEqual([prod.id]);
  });

  it('a live merchant with no connection gets NO_PSP_CONNECTED instead of a fallback', async () => {
    const m = await onboard('LIVE');
    const pay = await call(m.key, 'POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ab@okaxis', idempotencyKey: 'p1' });
    expect(pay.statusCode).toBe(422);
    expect(pay.json().error.code).toBe('NO_PSP_CONNECTED');
    const mandate = await call(m.key, 'POST', '/v1/mandates', { mandateRef: 'U', customerVpa: 'ab@okaxis', maxAmountPaise: rs(500) });
    expect(mandate.json().error.code).toBe('NO_PSP_CONNECTED');
    expect(shared.calls).toHaveLength(0);
  });

  it("routes a live merchant's payment through its own account, and records that account on the payment", async () => {
    const m = await onboard('LIVE');
    const prod = await connect(m.id, 'production');
    const pay = (await call(m.key, 'POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ab@okaxis', idempotencyKey: 'p1' })).json();
    expect(pay.pspId).toBe(prod.id);
    expect(shared.calls).toHaveLength(0);
  });

  it("refuses another merchant's connection id as a mandate PSP", async () => {
    const a = await onboard('LIVE');
    const b = await onboard('LIVE');
    const aConn = await connect(a.id, 'production');
    await connect(b.id, 'production');
    const res = await call(b.key, 'POST', '/v1/mandates', { mandateRef: 'U', customerVpa: 'ab@okaxis', maxAmountPaise: rs(500), eligiblePsps: [aConn.id] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Unknown PSPs/);
  });

  it('stops routing to a disabled connection, while its history stays resolvable', async () => {
    const m = await onboard('LIVE');
    const old = await connect(m.id, 'production', { priority: 1 });
    const fresh = await connect(m.id, 'production', { priority: 2 });
    await ctx.db.update(pspConnections).set({ status: 'DISABLED', updatedAt: new Date() }).where(eq(pspConnections.id, old.id));
    expect(await ctx.psps.idsFor(m.id)).toEqual([fresh.id]);
    expect((await ctx.psps.get(old.id)).id).toBe(old.id); // past payments can still be looked up
  });
});

describe('execution is limited to routable PSPs', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('platform-mock')], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
  });
  const merchant = async (mode: 'TEST' | 'LIVE') => {
    const app = buildApp(ctx);
    return (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'M', mode } })).json().merchant.id as string;
  };
  const connection = async (merchantId: string, over: Partial<typeof pspConnections.$inferInsert> = {}) =>
    (await ctx.db.insert(pspConnections).values({ id: newId('con'), merchantId, provider: 'mock', label: 'Own', environment: 'production', ...over }).returning())[0]!;

  it('keeps only the merchant\'s own active PSPs for its mode, in the given order', async () => {
    const a = await merchant('LIVE');
    const b = await merchant('LIVE');
    const a1 = await connection(a);
    const a2 = await connection(a, { status: 'DISABLED' });
    const b1 = await connection(b);
    const routable = await ctx.psps.routable(a, [b1.id, a2.id, 'platform-mock', a1.id]);
    expect(routable.map((p) => p.id)).toEqual([a1.id]);
  });

  it('skips a connection whose credentials cannot be opened instead of failing every payment', async () => {
    const m = await merchant('LIVE');
    await connection(m, { provider: 'cashfree', credentialsSealed: 'k9.bad.bad.bad', priority: 1 });
    const ok = await connection(m, { priority: 2 });
    expect(await ctx.psps.idsFor(m)).toEqual([ok.id]);
  });

  it('does not execute an AutoPay debit through a connection disabled after the mandate was registered', async () => {
    const m = await merchant('LIVE');
    const c = await connection(m);
    const [mandate] = await ctx.db.insert(mandates).values({ id: newId('mdt'), merchantId: m, mandateRef: 'UMN-1', customerVpa: 'ab@okaxis', maxAmountPaise: rs(500), eligiblePsps: [c.id] }).returning();
    const { debit } = await ctx.scheduler.createDebit(m, mandate!.id, { amountPaise: rs(499), idempotencyKey: 'd1' });
    await ctx.db.update(pspConnections).set({ status: 'DISABLED', updatedAt: new Date() }).where(eq(pspConnections.id, c.id));
    const adapter = (await ctx.psps.get(c.id)) as MockPsp;
    clock.set(debit.scheduledAt);
    await ctx.worker.runOnce();
    const [d] = await ctx.db.select().from(debits).where(eq(debits.id, debit.id));
    expect(d).toMatchObject({ state: 'FAILED', lastErrorCode: 'NO_PSP_CONNECTED', attempts: 0 });
    expect(adapter.calls.filter((x) => x.op === 'execute')).toHaveLength(0);
    // New debits on that mandate are refused at intake.
    await expect(ctx.scheduler.createDebit(m, mandate!.id, { amountPaise: rs(499), idempotencyKey: 'd2' })).rejects.toMatchObject({ code: 'NO_PSP_CONNECTED' });
  });

  it('never executes a live merchant\'s mandate through a shared adapter, even if the mandate lists it', async () => {
    const m = await merchant('LIVE');
    const [mandate] = await ctx.db.insert(mandates).values({ id: newId('mdt'), merchantId: m, mandateRef: 'UMN-2', customerVpa: 'ab@okaxis', maxAmountPaise: rs(500), eligiblePsps: ['platform-mock'] }).returning();
    await expect(ctx.scheduler.createDebit(m, mandate!.id, { amountPaise: rs(499), idempotencyKey: 'd3' })).rejects.toMatchObject({ code: 'NO_PSP_CONNECTED' });
  });
});
