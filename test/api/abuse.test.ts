import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('rate limits', () => {
  let app: FastifyInstance;
  const onboard = async (name: string) =>
    (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name } })).json().apiKey as string;
  const me = (key: string) => app.inject({ method: 'GET', url: '/v1/merchants/me', headers: { authorization: `Bearer ${key}` } });

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const ctx = buildContext({
      db,
      adapters: [new MockPsp('pspA')],
      adminToken: ADMIN,
      clock,
      sleep: clock.sleep,
      rateLimits: { apiPerMinute: 3, loginPerMinute: 2, publicPerMinute: 2 },
    });
    app = buildApp(ctx);
  });

  it('limits each API key separately, with a clear error and retry headers', async () => {
    const noisy = await onboard('Noisy');
    const quiet = await onboard('Quiet');
    for (let i = 0; i < 3; i++) expect((await me(noisy)).statusCode).toBe(200);
    const limited = await me(noisy);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBeDefined();
    // Another merchant is unaffected by the noisy one.
    expect((await me(quiet)).statusCode).toBe(200);
  });

  it('limits dashboard login attempts per client IP', async () => {
    const login = () =>
      app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email: 'x@y.example', password: 'nope-nope-nope' } });
    expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(429);
  });

  it('limits the public customer-status endpoint per client IP', async () => {
    const status = () => app.inject({ method: 'GET', url: '/public/payments/pay_x/status?token=t' });
    expect((await status()).statusCode).toBe(404);
    expect((await status()).statusCode).toBe(404);
    expect((await status()).statusCode).toBe(429);
  });

  it('never limits health checks or static dashboard assets', async () => {
    for (let i = 0; i < 6; i++) expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    for (let i = 0; i < 6; i++) expect((await app.inject({ method: 'GET', url: '/dashboard/app.js' })).statusCode).toBe(200);
  });
});

describe('merchant webhook URLs (production policy)', () => {
  it('refuses webhook URLs that are not https or point at internal networks', async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep, webhookTargets: 'public-only' });
    const app = buildApp(ctx);
    const onboard = (webhookUrl: string) =>
      app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'M', webhookUrl } });
    for (const bad of ['http://hooks.merchant.example/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://10.0.0.8/hooks']) {
      const res = await onboard(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.message).toMatch(/^webhookUrl /);
    }
    expect((await onboard('https://hooks.merchant.example/upi')).statusCode).toBe(201);
  });
});
