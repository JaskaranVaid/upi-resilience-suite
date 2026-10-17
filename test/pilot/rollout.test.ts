import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { operatorAudit, rolloutChanges, webhookOutbox } from '../../src/db/schema.js';
import { canaryBucket, executorFor } from '../../src/pilot/rollout.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';

describe('canary assignment', () => {
  it('puts each mandate in a stable bucket from 0 to 99', () => {
    expect(canaryBucket('mdt_abc')).toBe(canaryBucket('mdt_abc'));
    const buckets = Array.from({ length: 2000 }, (_, i) => canaryBucket(`mdt_${i}`));
    expect(Math.min(...buckets)).toBe(0);
    expect(Math.max(...buckets)).toBe(99);
    // Roughly uniform: each decile holds 10% ± 3% of 2,000 mandates.
    for (let d = 0; d < 10; d++) {
      const share = buckets.filter((b) => Math.floor(b / 10) === d).length / buckets.length;
      expect(share).toBeGreaterThan(0.07);
      expect(share).toBeLessThan(0.13);
    }
  });

  it('decides who executes from the stage, and only adds mandates as the canary grows', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `mdt_${i}`);
    expect(ids.every((id) => executorFor({ rolloutStage: 'FULL', canaryPercent: null }, id) === 'MERCHANTFLO')).toBe(true);
    expect(ids.every((id) => executorFor({ rolloutStage: 'SHADOW', canaryPercent: null }, id) === 'MERCHANT')).toBe(true);
    const inCanary = (p: number) => new Set(ids.filter((id) => executorFor({ rolloutStage: 'CANARY', canaryPercent: p }, id) === 'MERCHANTFLO'));
    const five = inCanary(5);
    const ten = inCanary(10);
    expect(five.size).toBeGreaterThan(10);
    expect(ten.size).toBeGreaterThan(five.size);
    for (const id of five) expect(ten.has(id)).toBe(true);
  });
});

describe('rollout stage changes', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;

  const onboard = async (mode: 'TEST' | 'LIVE' = 'TEST') => {
    const r = (
      await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'StreamCo', mode, webhookUrl: 'https://merchant.example/hooks' } })
    ).json();
    return { id: r.merchant.id as string, key: r.apiKey as string };
  };
  const pilot = async (key: string) => (await app.inject({ method: 'GET', url: '/v1/pilot', headers: { authorization: `Bearer ${key}` } })).json();

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-16T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
  });

  it('keeps test-mode merchants FULL, with no pilot history', async () => {
    const m = await onboard('TEST');
    expect(await pilot(m.key)).toEqual({ stage: 'FULL', canaryPercent: null, since: null });
  });

  it('starts a live-mode merchant in SHADOW, whether onboarded live or switched to live, and only the first time', async () => {
    const direct = await onboard('LIVE');
    expect(await pilot(direct.key)).toMatchObject({ stage: 'SHADOW', canaryPercent: null });

    const m = await onboard('TEST');
    const toLive = await app.inject({ method: 'PATCH', url: `/v1/admin/merchants/${m.id}`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { mode: 'LIVE' } });
    expect(toLive.json().merchant).toMatchObject({ mode: 'LIVE', rolloutStage: 'SHADOW' });
    const [change] = await ctx.db.select().from(rolloutChanges).where(eq(rolloutChanges.merchantId, m.id));
    expect(change).toMatchObject({ fromStage: 'FULL', toStage: 'SHADOW', operatorId: null });

    // An operator moves it on; going back to TEST and LIVE again does not reset it.
    await ctx.rollout.change(m.id, { stage: 'FULL', reason: 'greenfield merchant, no legacy path', override: true }, { operatorId: 'opr_1', role: 'OWNER' });
    for (const mode of ['TEST', 'LIVE']) {
      await app.inject({ method: 'PATCH', url: `/v1/admin/merchants/${m.id}`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { mode } });
    }
    const key = (await app.inject({ method: 'PATCH', url: `/v1/admin/merchants/${m.id}`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { mode: 'TEST' } })).json().apiKey;
    expect((await pilot(key)).stage).toBe('FULL');
  });

  it('records each change with history, an audit entry and a webhook to the merchant', async () => {
    const m = await onboard('TEST');
    await ctx.rollout.change(m.id, { stage: 'SHADOW', reason: 'pilot week 1' }, { operatorId: 'opr_1', role: 'OPERATOR' });
    clock.advance(3600_000);
    const changed = await ctx.rollout.change(m.id, { stage: 'CANARY', canaryPercent: 5, reason: 'shadow report reviewed' }, { operatorId: 'opr_1', role: 'OPERATOR' });
    expect(changed).toMatchObject({ rolloutStage: 'CANARY', canaryPercent: 5 });
    expect(await pilot(m.key)).toEqual({ stage: 'CANARY', canaryPercent: 5, since: clock.now().toISOString() });

    const history = await ctx.rollout.history(m.id);
    expect(history.map((h) => [h.fromStage, h.toStage, h.toPercent])).toEqual([
      ['FULL', 'SHADOW', null],
      ['SHADOW', 'CANARY', 5],
    ]);
    const audit = await ctx.db.select().from(operatorAudit).where(eq(operatorAudit.action, 'ROLLOUT_CHANGED'));
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ operatorId: 'opr_1', target: m.id, details: { from: 'SHADOW', to: 'CANARY', canaryPercent: 5, reason: 'shadow report reviewed' } });

    const hooks = await ctx.db.select().from(webhookOutbox).where(eq(webhookOutbox.event, 'pilot.stage_changed'));
    expect(hooks.map((h) => h.payload)).toContainEqual({ stage: 'CANARY', canaryPercent: 5, previousStage: 'SHADOW', previousCanaryPercent: null, changedAt: clock.now().toISOString() });
  });

  it('refuses invalid changes', async () => {
    const m = await onboard('TEST');
    const by = { operatorId: 'opr_1', role: 'OPERATOR' as const };
    await expect(ctx.rollout.change(m.id, { stage: 'CANARY', reason: 'x' }, by)).rejects.toThrow(/percentage/);
    await expect(ctx.rollout.change(m.id, { stage: 'CANARY', canaryPercent: 100, reason: 'x' }, by)).rejects.toThrow(/1 and 99/);
    await expect(ctx.rollout.change(m.id, { stage: 'SHADOW', canaryPercent: 5, reason: 'x' }, by)).rejects.toThrow(/only for CANARY/);
    await expect(ctx.rollout.change(m.id, { stage: 'FULL', reason: 'x' }, by)).rejects.toThrow(/already FULL/);
    await expect(ctx.rollout.change(m.id, { stage: 'SHADOW', reason: '  ' }, by)).rejects.toThrow(/reason/);
    await expect(ctx.rollout.change('mer_nope', { stage: 'SHADOW', reason: 'x' }, by)).rejects.toThrow(/not found/);
    await expect(ctx.rollout.change(m.id, { stage: 'SHADOW', reason: 'x', override: true }, by)).rejects.toThrow(/owner/i);
  });
});
