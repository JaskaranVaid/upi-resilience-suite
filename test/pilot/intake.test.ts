import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { debitResponse, mandateResponse, shadowDebitResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { getRuleSet } from '../../src/config/rules.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, merchants, shadowDebits } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { executorFor } from '../../src/pilot/rollout.js';
import { MockPsp } from '../../src/psp/mock.js';
import { isRestricted } from '../../src/rules/windows.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';
const OWNER = { operatorId: 'opr_1', role: 'OWNER' as const };

describe('debit intake: who executes each debit', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let psp: MockPsp;
  let merchant: { id: string; key: string };

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, key = merchant.key) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const mandate = async (ref: string, over: Record<string, unknown> = {}, key = merchant.key) =>
    (await call('POST', '/v1/mandates', { mandateRef: ref, customerVpa: 'asha@okhdfc', maxAmountPaise: rs(50_000), ...over }, key)).json() as { id: string };
  const debit = (mandateId: string, idempotencyKey: string, amountPaise = rs(499), key = merchant.key) =>
    call('POST', `/v1/mandates/${mandateId}/debits`, { amountPaise, idempotencyKey }, key);
  const stage = (to: { stage: 'SHADOW' | 'CANARY' | 'FULL'; canaryPercent?: number }) => ctx.rollout.change(merchant.id, { ...to, reason: 'test', override: true }, OWNER);
  const onboard = async (name: string) => {
    const r = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name, webhookUrl: 'https://merchant.example/hooks' } })).json();
    return { id: r.merchant.id as string, key: r.apiKey as string };
  };

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-16T14:00:00'));
    psp = new MockPsp('pspA');
    ctx = buildContext({ db, adapters: [psp], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    merchant = await onboard('StreamCo');
  });

  it('FULL: Merchantflo executes, as before, and the debit says so', async () => {
    const m = await mandate('UMN-1');
    const res = await debit(m.id, 'inv-1');
    expect(res.statusCode).toBe(201);
    const body = debitResponse.parse(res.json());
    expect(body).toMatchObject({ executedBy: 'MERCHANTFLO', state: 'SCHEDULED' });
    expect((await ctx.db.select().from(debits).where(eq(debits.id, body.id)))[0]!.rolloutStage).toBe('FULL');
    expect(psp.calls.filter((c) => c.op === 'notice')).toHaveLength(1);
  });

  it('SHADOW: plans the debit like a live one but never notifies, executes or schedules it', async () => {
    await stage({ stage: 'SHADOW' });
    // 18:00 IST, inside the evening peak: the billing system fires now.
    clock.set(ist('2026-10-16T18:00:00'));
    const m = await mandate('UMN-1');
    const res = await debit(m.id, 'inv-1');
    expect(res.statusCode).toBe(201);
    const body = shadowDebitResponse.parse(res.json());
    expect(body).toMatchObject({ object: 'shadow_debit', executedBy: 'MERCHANT', mandateId: m.id, mandateRef: 'UMN-1', source: 'MIRRORED', rolloutStage: 'SHADOW', requestedInPeak: true, wouldRefuse: null, outcome: null });
    expect(body.id).toMatch(/^shd_/);
    const plannedAt = new Date(body.plannedAt);
    expect(isRestricted(plannedAt, getRuleSet(plannedAt).windows)).toBe(false);
    expect(plannedAt.getTime() - clock.now().getTime()).toBeGreaterThanOrEqual(24 * 3600_000);

    // Days pass with the worker running: nothing reaches a PSP, no live debit exists.
    for (let h = 0; h < 96; h++) {
      clock.advance(3600_000);
      await ctx.worker.runOnce();
    }
    expect(psp.calls).toEqual([]);
    expect(await ctx.db.select().from(debits)).toEqual([]);
  });

  it('CANARY: Merchantflo executes only the mandates in the canary, recorded as such', async () => {
    await stage({ stage: 'CANARY', canaryPercent: 50 });
    const [row] = await ctx.db.select().from(merchants).where(eq(merchants.id, merchant.id));
    const seen = { MERCHANTFLO: 0, MERCHANT: 0 };
    for (let i = 0; i < 12; i++) {
      const m = await mandate(`UMN-${i}`);
      const body = (await debit(m.id, `inv-${i}`)).json();
      const expected = executorFor(row!, m.id);
      expect(body.executedBy).toBe(expected);
      seen[expected]++;
      if (expected === 'MERCHANTFLO') expect((await ctx.db.select().from(debits).where(eq(debits.id, body.id)))[0]!.rolloutStage).toBe('CANARY');
      else expect((await ctx.db.select().from(shadowDebits).where(eq(shadowDebits.id, body.id)))[0]!.rolloutStage).toBe('CANARY');
    }
    expect(seen.MERCHANTFLO).toBeGreaterThan(0);
    expect(seen.MERCHANT).toBeGreaterThan(0);
  });

  it('a retry after a stage change returns the debit as first accepted — never a second one', async () => {
    const m = await mandate('UMN-1');
    await stage({ stage: 'SHADOW' });
    const first = (await debit(m.id, 'inv-1')).json();
    await stage({ stage: 'FULL' });
    const retry = await debit(m.id, 'inv-1');
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: first.id, executedBy: 'MERCHANT' });

    const live = (await debit(m.id, 'inv-2')).json();
    await stage({ stage: 'SHADOW' });
    const again = await debit(m.id, 'inv-2');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: live.id, executedBy: 'MERCHANTFLO' });
    expect(await ctx.db.select().from(shadowDebits)).toHaveLength(1);
    expect(await ctx.db.select().from(debits)).toHaveLength(1);
  });

  it('refuses a key reused for a different shadow debit', async () => {
    await stage({ stage: 'SHADOW' });
    const m = await mandate('UMN-1');
    await debit(m.id, 'inv-1');
    const reused = await debit(m.id, 'inv-1', rs(999));
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('creates one debit when the same request arrives twice at once', async () => {
    await stage({ stage: 'SHADOW' });
    const m = await mandate('UMN-1');
    const [a, b] = await Promise.all([debit(m.id, 'inv-1'), debit(m.id, 'inv-1')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    expect(await ctx.db.select().from(shadowDebits)).toHaveLength(1);
  });

  it('a key already held by a shadow debit is never turned into a live debit, even by a racing request', async () => {
    const m = await mandate('UMN-1');
    // A concurrent shadow insert won the race after intake looked (simulated by writing it directly).
    await ctx.db.insert(shadowDebits).values({
      id: newId('shd'), merchantId: merchant.id, mandateId: m.id, mandateRef: 'UMN-1', idempotencyKey: 'inv-1', amountPaise: rs(499),
      source: 'MIRRORED', rolloutStage: 'SHADOW', requestedAt: clock.now(), requestedInPeak: false, plannedAt: clock.now(), plannedNoticeDate: '2026-10-17',
    });
    await expect(ctx.scheduler.createDebit(merchant.id, m.id, { amountPaise: rs(499), idempotencyKey: 'inv-1' })).rejects.toThrow(/shadow/i);
    expect(await ctx.db.select().from(debits)).toEqual([]);
    const res = await debit(m.id, 'inv-1');
    expect(res.json()).toMatchObject({ executedBy: 'MERCHANT' });
  });

  it('records what live intake would have refused instead of refusing a debit the merchant executes anyway', async () => {
    await stage({ stage: 'SHADOW' });
    const big = await mandate('UMN-1');
    expect((await debit(big.id, 'inv-1', rs(20_000))).json()).toMatchObject({ wouldRefuse: 'AFA_REQUIRED' });
    expect((await debit(big.id, 'inv-2', rs(60_000))).json()).toMatchObject({ wouldRefuse: 'AMOUNT_EXCEEDS_MANDATE' });
    const revoked = await mandate('UMN-2');
    await call('POST', `/v1/mandates/${revoked.id}/revoke`);
    const r = await debit(revoked.id, 'inv-3');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ wouldRefuse: 'MANDATE_INACTIVE' });
    expect((await debit('mdt_unknown', 'inv-4')).statusCode).toBe(404);
  });

  it("shows who executes a mandate's new debits, and lists and retrieves shadow debits per merchant", async () => {
    await stage({ stage: 'SHADOW' });
    const m = await mandate('UMN-1');
    expect(mandateResponse.parse((await call('GET', `/v1/mandates/${m.id}`)).json()).executedBy).toBe('MERCHANT');
    const created = (await debit(m.id, 'inv-1')).json();

    const got = await call('GET', `/v1/shadow-debits/${created.id}`);
    expect(shadowDebitResponse.parse(got.json()).id).toBe(created.id);
    const list = (await call('GET', '/v1/shadow-debits')).json();
    expect(list.data.map((d: { id: string }) => d.id)).toEqual([created.id]);

    const other = await onboard('Other Co');
    expect((await call('GET', `/v1/shadow-debits/${created.id}`, undefined, other.key)).statusCode).toBe(404);
    expect((await call('GET', '/v1/shadow-debits', undefined, other.key)).json().data).toEqual([]);
  });
});
