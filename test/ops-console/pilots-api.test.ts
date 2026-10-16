import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { totpCode } from '../../src/auth/totp.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { duplicateSuspects, shadowDebits, type OperatorRole } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs, seedMerchant } from '../helpers/fixtures.js';

const CSRF = { 'x-ops-request': '1' };

describe('ops console API: pilots and duplicates', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let pilotId: string;
  let otherId: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20), clock, secureCookies: true });
    app = buildApp(ctx);
    pilotId = (await seedMerchant(db, { name: 'Pilot OTT' })).id;
    otherId = (await seedMerchant(db, { name: 'Not In A Pilot' })).id;
    await ctx.rollout.change(pilotId, { stage: 'SHADOW', reason: 'pilot agreement signed' }, { operatorId: null, role: 'OWNER' });
  });

  async function signIn(role: OperatorRole) {
    const email = `${role.toLowerCase()}@merchantflo.in`;
    const { password, otpauthUri } = await ctx.operators.create({ email, name: role, role }, null);
    const secret = new URL(otpauthUri).searchParams.get('secret')!;
    const res = await app.inject({ method: 'POST', url: '/ops/api/login', headers: CSRF, payload: { email, password, code: totpCode(secret, clock.now()) } });
    return `mf_ops=${res.cookies.find((c) => c.name === 'mf_ops')!.value}`;
  }
  const as = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { cookie, ...(method === 'POST' ? CSRF : {}) } });
  const suspect = (merchantId = pilotId) =>
    ctx.db
      .insert(duplicateSuspects)
      .values({
        id: newId('dup'), merchantId, mandateRef: 'UMN-1@psp', amountPaise: rs(499), firstKind: 'DEBIT', firstId: newId('dbt'), secondKind: 'SHADOW', secondId: newId('shd'),
        firstAt: ist('2026-10-15T08:00:00'), secondAt: ist('2026-10-15T09:00:00'), sameOrder: true, detectedAt: ist('2026-10-15T09:10:00'),
      })
      .returning()
      .then(([s]) => s!);

  it('requires a signed-in operator', async () => {
    for (const url of ['/ops/api/pilots', `/ops/api/pilots/${pilotId}`, `/ops/api/pilots/${pilotId}/report.csv`, '/ops/api/duplicates']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: `/ops/api/pilots/${pilotId}/stage`, headers: CSRF, payload: { stage: 'FULL', reason: 'x' } })).statusCode).toBe(401);
  });

  it('lists the merchants in a pilot, with open suspects', async () => {
    const cookie = await signIn('VIEWER');
    await suspect();
    const { data } = (await as(cookie, 'GET', '/ops/api/pilots')).json();
    expect(data).toEqual([{ merchantId: pilotId, name: 'Pilot OTT', mode: 'TEST', stage: 'SHADOW', canaryPercent: null, since: clock.now().toISOString(), openSuspects: 1 }]);
    expect(data.map((p: { merchantId: string }) => p.merchantId)).not.toContain(otherId);
  });

  it("shows a pilot's scorecard, shadow report, history, suspects and what blocks the next step", async () => {
    const cookie = await signIn('VIEWER');
    await suspect();
    const res = await as(cookie, 'GET', `/ops/api/pilots/${pilotId}?month=2026-10`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.merchant).toEqual({ id: pilotId, name: 'Pilot OTT', mode: 'TEST', hasWebhookUrl: true });
    expect(d.rollout).toMatchObject({ stage: 'SHADOW' });
    expect(d.history).toEqual([expect.objectContaining({ fromStage: 'FULL', toStage: 'SHADOW', reason: 'pilot agreement signed' })]);
    expect(d.next).toEqual({ stage: 'CANARY', canaryPercent: 5, problems: ['1 suspected double debit not reviewed'] });
    expect(d.scorecard.criteria).toHaveLength(5);
    expect(d.report).toMatchObject({ observed: { count: 0 } });
    expect(d.duplicates).toHaveLength(1);
    expect((await as(cookie, 'GET', '/ops/api/pilots/mer_nope')).statusCode).toBe(404);
  });

  it('changes the stage behind the gates; viewers cannot, only owners override', async () => {
    const viewer = await signIn('VIEWER');
    const operator = await signIn('OPERATOR');
    const owner = await signIn('OWNER');
    const url = `/ops/api/pilots/${pilotId}/stage`;
    expect((await as(viewer, 'POST', url, { stage: 'CANARY', canaryPercent: 5, reason: 'x' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: operator }, payload: { stage: 'CANARY', canaryPercent: 5, reason: 'x' } })).statusCode).toBe(403);
    expect((await as(operator, 'POST', url, { stage: 'CANARY', canaryPercent: 150, reason: 'x' })).statusCode).toBe(400);

    const ok = await as(operator, 'POST', url, { stage: 'CANARY', canaryPercent: 5, reason: 'shadow report reviewed' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ stage: 'CANARY', canaryPercent: 5 });

    const early = await as(operator, 'POST', url, { stage: 'FULL', reason: 'looks good' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toMatch(/0 days in CANARY; needs 7/);
    expect((await as(operator, 'POST', url, { stage: 'FULL', reason: 'looks good', override: true })).statusCode).toBe(403);
    expect((await as(owner, 'POST', url, { stage: 'FULL', reason: 'merchant asked; risk accepted', override: true })).json()).toEqual({ stage: 'FULL', canaryPercent: null });
    expect((await as(viewer, 'GET', `/ops/api/pilots/${pilotId}`)).json().next).toBeNull();

    // The rollback needs no gate.
    expect((await as(operator, 'POST', url, { stage: 'SHADOW', reason: 'incident: rolling back' })).json()).toEqual({ stage: 'SHADOW', canaryPercent: null });
    const audit = (await as(owner, 'GET', '/ops/api/audit')).json().data.filter((a: { action: string }) => a.action === 'ROLLOUT_CHANGED');
    expect(audit).toHaveLength(4);
    expect(audit.find((a: { details: { to: string } }) => a.details.to === 'FULL')).toMatchObject({ operatorEmail: 'owner@merchantflo.in', details: { override: true } });
  });

  it('downloads the shadow report rows as CSV', async () => {
    const cookie = await signIn('VIEWER');
    const at = ist('2026-10-06T18:30:00');
    await ctx.db.insert(shadowDebits).values({
      id: newId('shd'), merchantId: pilotId, mandateRef: 'UMN-9@psp', idempotencyKey: 'k-1', amountPaise: rs(1000), source: 'REPORTED', rolloutStage: 'SHADOW',
      requestedAt: at, requestedInPeak: true, plannedAt: at, plannedNoticeDate: '2026-10-05', executedAt: at, outcome: 'FAILED', failureKind: 'TECHNICAL',
    });
    const res = await as(cookie, 'GET', `/ops/api/pilots/${pilotId}/report.csv?month=2026-10`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="shadow-report-pilot-ott-2026-10.csv"');
    const lines = res.body.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('PEAK_RESCUE');
  });

  it('queues suspects across merchants and records each resolution', async () => {
    const viewer = await signIn('VIEWER');
    const operator = await signIn('OPERATOR');
    const a = await suspect();
    await suspect(otherId);
    const all = (await as(viewer, 'GET', '/ops/api/duplicates?status=OPEN')).json().data;
    expect(all).toHaveLength(2);
    expect(all.map((s: { merchantName: string }) => s.merchantName).sort()).toEqual(['Not In A Pilot', 'Pilot OTT']);
    expect((await as(viewer, 'GET', `/ops/api/duplicates?merchantId=${pilotId}`)).json().data).toHaveLength(1);

    const url = `/ops/api/duplicates/${a.id}/resolve`;
    expect((await as(viewer, 'POST', url, { resolution: 'DISMISSED', note: 'two invoices' })).statusCode).toBe(403);
    expect((await as(operator, 'POST', url, { resolution: 'DISMISSED', note: '' })).statusCode).toBe(400);
    const done = await as(operator, 'POST', url, { resolution: 'DISMISSED', note: 'two invoices, merchant confirmed' });
    expect(done.json()).toMatchObject({ id: a.id, status: 'DISMISSED', resolutionNote: 'two invoices, merchant confirmed' });
    expect((await as(operator, 'POST', url, { resolution: 'CONFIRMED', note: 'again' })).statusCode).toBe(409);
    expect((await as(viewer, 'GET', '/ops/api/duplicates?status=OPEN')).json().data).toHaveLength(1);
    expect((await as(viewer, 'GET', '/ops/api/metrics')).json()).toMatchObject({ duplicateDebitsOpen: 1 });
  });
});
