import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';

describe('pilot API: scorecard and shadow report', () => {
  let app: FastifyInstance;
  let key: string;
  const get = (url: string, k = key) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${k}` } });

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-20T12:00:00'));
    app = buildApp(buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep }));
    key = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'StreamCo' } })).json().apiKey;
  });

  it('returns the five criteria for a billing month or a range', async () => {
    const res = await get('/v1/pilot/scorecard?month=2026-10');
    expect(res.statusCode).toBe(200);
    expect(res.json().criteria.map((c: { key: string }) => c.key)).toEqual(['doubleDebits', 'restrictedWindowExecutions', 'autopayUplift', 'webhooksOnTime', 'statementReconciles']);
    expect((await get('/v1/pilot/scorecard?from=2026-10-01T00:00:00%2B05:30&to=2026-10-08T00:00:00%2B05:30')).json().period.month).toBeNull();
    expect((await get('/v1/pilot/scorecard?month=2026-13')).statusCode).toBe(400);
  });

  it("returns the shadow report of the merchant's own reported executions", async () => {
    await app.inject({
      method: 'POST', url: '/v1/pilot/executions', headers: { authorization: `Bearer ${key}` },
      payload: { executions: [{ idempotencyKey: 'h-1', mandateRef: 'UMN-1', amountPaise: rs(1000), executedAt: '2026-10-06T18:30:00+05:30', outcome: 'FAILED', failureKind: 'TECHNICAL' }] },
    });
    const res = await get('/v1/pilot/report?month=2026-10');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ certainPaise: rs(1000), potentialPaise: 0, observed: { count: 1 } });
    const other = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Other' } })).json().apiKey;
    expect((await get('/v1/pilot/report?month=2026-10', other)).json().observed.count).toBe(0);
  });
});
