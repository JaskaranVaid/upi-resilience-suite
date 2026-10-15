import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { savingsEvents } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN_TOKEN = 'test-admin-token-123';
const PW = 'correct horse battery';

describe('analytics API', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let pspA: MockPsp;
  let pspB: MockPsp;

  async function merchant(name: string) {
    const m = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name } });
    const apiKey = m.json().apiKey as string;
    const cookies: Record<string, string> = {};
    for (const role of ['ADMIN', 'VIEWER']) {
      const email = `${role.toLowerCase()}@${name.toLowerCase().replace(/\W/g, '')}.example`;
      await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${apiKey}` }, payload: { email, name: role, password: PW, role } });
      const res = await app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email, password: PW } });
      cookies[role] = `rs_session=${res.cookies.find((c) => c.name === 'rs_session')!.value}`;
    }
    return { id: m.json().merchant.id as string, apiKey, cookies };
  }
  const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    pspA = new MockPsp('pspA');
    pspB = new MockPsp('pspB');
    ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: ADMIN_TOKEN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
  });

  it('shows value recovered by a real failover, for any role, in the current IST month by default', async () => {
    const m = await merchant('StreamCo OTT');
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' });
    pspB.enqueue({ kind: 'SUCCESS', pspTxnId: 'B1' });
    await app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${m.apiKey}` }, payload: { amountPaise: rs(2500), payerVpa: 'ravi@okicici', idempotencyKey: 'o1', orderId: 'ORD-1' } });

    for (const role of ['ADMIN', 'VIEWER']) {
      const res = await get(m.cookies[role]!, '/dashboard/api/analytics/value');
      expect(res.statusCode).toBe(200);
      const v = res.json();
      expect(v.period).toMatchObject({ month: '2026-10', label: 'October 2026' });
      expect(v.headline).toMatchObject({ key: 'routingRecovered', count: 1, amountPaise: rs(2500) });
      expect(v.uplift).toMatchObject({ submitted: 1, recovered: 1, actualSuccessRate: 1, withoutRecoverySuccessRate: 0 });
    }

    const psps = (await get(m.cookies.VIEWER!, '/dashboard/api/analytics/psps')).json();
    expect(psps.providers.map((p: { pspId: string; attempts: number; technicalDeclines: number }) => [p.pspId, p.attempts, p.technicalDeclines])).toEqual([
      ['pspA', 1, 1],
      ['pspB', 1, 0],
    ]);
    expect((await get(m.cookies.VIEWER!, '/dashboard/api/analytics/issues')).statusCode).toBe(200);
  });

  it('requires a session and validates periods', async () => {
    const m = await merchant('Shop');
    expect((await app.inject({ method: 'GET', url: '/dashboard/api/analytics/value' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/dashboard/api/analytics/statement.csv' })).statusCode).toBe(401);
    for (const q of ['month=2026-13', 'month=Oct', 'from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z', 'from=2026-10-01T00:00:00Z']) {
      const res = await get(m.cookies.VIEWER!, `/dashboard/api/analytics/value?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
    const custom = await get(m.cookies.VIEWER!, '/dashboard/api/analytics/value?from=2026-10-01T00:00:00%2B05:30&to=2026-10-08T00:00:00%2B05:30');
    expect(custom.json().daily).toHaveLength(7);
  });

  it('never mixes merchants', async () => {
    const a = await merchant('Alpha');
    const b = await merchant('Beta');
    await ctx.db.insert(savingsEvents).values({ id: newId('sav'), merchantId: b.id, type: 'TD_RECOVERED', amountPaise: rs(5000), refId: newId('pay'), createdAt: ist('2026-10-10T10:00:00') });
    expect((await get(a.cookies.ADMIN!, '/dashboard/api/analytics/value')).json().grossTotalPaise).toBe(0);
    expect((await get(b.cookies.ADMIN!, '/dashboard/api/analytics/value')).json().grossTotalPaise).toBe(rs(5000));
    const csv = (await get(a.cookies.ADMIN!, '/dashboard/api/analytics/value-events.csv')).body;
    expect(csv.trim().split('\r\n')).toHaveLength(1); // header only
  });

  it('downloads the monthly statement and line items as CSV attachments', async () => {
    const m = await merchant('StreamCo OTT');
    for (const [kind, header] of [['statement', 'section,metric'], ['value-events', 'date_ist,source']] as const) {
      const res = await get(m.cookies.VIEWER!, `/dashboard/api/analytics/${kind}.csv?month=2026-09`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${kind}-streamco-ott-2026-09.csv"`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.startsWith(header)).toBe(true);
    }
  });
});
