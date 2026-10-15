import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';

describe('security headers', () => {
  let db: Db;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });
  const app = (secureCookies: boolean) => buildApp(buildContext({ db, adapters: [], adminToken: ADMIN, clock: new FakeClock(ist('2026-10-15T14:00:00')), secureCookies }));

  it('marks every response nosniff', async () => {
    const a = app(false);
    for (const url of ['/health', '/v1/rules', '/healthz', '/openapi.json']) {
      expect((await a.inject({ method: 'GET', url })).headers['x-content-type-options'], url).toBe('nosniff');
    }
  });

  it('keeps API responses out of caches', async () => {
    const a = app(false);
    const res = await a.inject({ method: 'GET', url: '/v1/admin/ops/metrics', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // An error from the API is not cacheable either.
    expect((await a.inject({ method: 'GET', url: '/v1/rules' })).headers['cache-control']).toBe('no-store');
  });

  it('leaves the cacheable widget alone', async () => {
    const res = await app(false).inject({ method: 'GET', url: '/checkout/v1/checkout.js' });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('sends HSTS in production (HTTPS) only', async () => {
    expect((await app(true).inject({ method: 'GET', url: '/healthz' })).headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect((await app(false).inject({ method: 'GET', url: '/healthz' })).headers['strict-transport-security']).toBeUndefined();
  });
});
