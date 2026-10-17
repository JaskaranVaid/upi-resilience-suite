import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { pilotScorecardResponse, shadowReportResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-123';
const PW = 'correct horse battery';

describe('dashboard: pilot tab', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let apiKey: string;
  let viewer: string;

  const onboard = async (name: string) => {
    const m = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name } })).json();
    const email = `viewer@${name.toLowerCase()}.example`;
    await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${m.apiKey}` }, payload: { email, name: 'Viewer', password: PW, role: 'VIEWER' } });
    const res = await app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email, password: PW } });
    return { id: m.merchant.id as string, apiKey: m.apiKey as string, cookie: `rs_session=${res.cookies.find((c) => c.name === 'rs_session')!.value}` };
  };
  const get = (url: string, cookie = viewer) => app.inject({ method: 'GET', url, headers: { cookie } });
  const report = (key = apiKey) =>
    app.inject({
      method: 'POST', url: '/v1/pilot/executions', headers: { authorization: `Bearer ${key}` },
      payload: { executions: [{ idempotencyKey: 'hist-1', mandateRef: 'UMN-1', amountPaise: rs(1000), executedAt: '2026-10-06T18:30:00+05:30', outcome: 'FAILED', failureKind: 'TECHNICAL' }] },
    });

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-20T12:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep });
    app = buildApp(ctx);
    ({ apiKey, cookie: viewer } = await onboard('StreamCo'));
  });

  it('shows the tab only to a merchant in a pilot, after one, or with shadow data', async () => {
    expect((await get('/dashboard/api/meta')).json().pilot).toEqual({ stage: 'FULL', canaryPercent: null, since: null, show: false });
    await report(); // a backtest before any pilot
    expect((await get('/dashboard/api/meta')).json().pilot.show).toBe(true);

    const other = await onboard('FitPass');
    await ctx.rollout.change(other.id, { stage: 'SHADOW', reason: 'pilot' }, { operatorId: null, role: 'OWNER' });
    expect((await get('/dashboard/api/meta', other.cookie)).json().pilot).toMatchObject({ stage: 'SHADOW', show: true });
  });

  it("returns the merchant's own stage, scorecard and shadow report to every role", async () => {
    await report();
    const res = await get('/dashboard/api/pilot?month=2026-10');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rollout).toEqual({ stage: 'FULL', canaryPercent: null, since: null });
    pilotScorecardResponse.parse(body.scorecard);
    shadowReportResponse.parse(body.report);
    expect(body.report).toMatchObject({ certainPaise: rs(1000), observed: { count: 1 } });

    const other = await onboard('FitPass');
    expect((await get('/dashboard/api/pilot?month=2026-10', other.cookie)).json().report.observed.count).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/dashboard/api/pilot' })).statusCode).toBe(401);
    expect((await get('/dashboard/api/pilot?month=nope')).statusCode).toBe(400);
  });

  it('downloads the shadow report rows as CSV', async () => {
    await report();
    const res = await get('/dashboard/api/pilot/report.csv?month=2026-10');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="shadow-report-streamco-2026-10.csv"');
    expect(res.body).toContain('PEAK_RESCUE');
  });
});
