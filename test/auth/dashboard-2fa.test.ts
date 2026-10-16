import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { totpCode } from '../../src/auth/totp.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { dashboardUsers, paymentEvents } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN_TOKEN = 'test-admin-token-123';
const PW = 'correct horse battery';
const CSRF = { 'x-dashboard-request': '1' };

describe('dashboard two-factor sign-in (optional per user)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let apiKey: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN_TOKEN, clock, sleep: clock.sleep });
    app = buildApp(ctx);
    apiKey = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name: 'StreamCo' } })).json().apiKey;
    for (const [email, role] of [['admin@streamco.example', 'ADMIN'], ['agent@streamco.example', 'SUPPORT']]) {
      const r = await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${apiKey}` }, payload: { email, name: role, password: PW, role } });
      expect(r.statusCode).toBe(201);
    }
  });

  const login = (email: string, code?: string, password = PW) =>
    app.inject({ method: 'POST', url: '/dashboard/api/login', headers: CSRF, payload: { email, password, ...(code === undefined ? {} : { code }) } });
  const cookieOf = (res: Awaited<ReturnType<typeof login>>) => `rs_session=${res.cookies.find((c) => c.name === 'rs_session')!.value}`;
  const as = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie, ...(method === 'GET' ? {} : CSRF) } });

  /** Signs in, enrols an authenticator and returns its secret. */
  async function enrol(email: string) {
    const cookie = cookieOf(await login(email));
    const setup = await as(cookie, 'POST', '/dashboard/api/me/2fa/setup');
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUri, qrSvg } = setup.json();
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(qrSvg).toMatch(/^<svg/);
    // Not on until confirmed: sign-in still needs no code.
    expect((await login(email)).statusCode).toBe(200);
    expect((await as(cookie, 'POST', '/dashboard/api/me/2fa/confirm', { code: '000000' })).statusCode).toBe(401);
    const confirm = await as(cookie, 'POST', '/dashboard/api/me/2fa/confirm', { code: totpCode(secret, clock.now()) });
    expect(confirm.statusCode).toBe(200);
    expect((await as(cookie, 'GET', '/dashboard/api/me')).json().user).toMatchObject({ twoFactor: true });
    clock.advance(30_000);
    return { secret, cookie };
  }

  it('signs in without a code until two-factor is turned on', async () => {
    const res = await login('agent@streamco.example');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ twoFactor: false });
  });

  it('once on, asks for the code, refuses a wrong one and accepts the right one once', async () => {
    const { secret } = await enrol('agent@streamco.example');

    const noCode = await login('agent@streamco.example');
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error.code).toBe('MFA_REQUIRED');
    expect(noCode.cookies.find((c) => c.name === 'rs_session')).toBeUndefined();
    // A wrong password never reveals that a code is needed.
    expect((await login('agent@streamco.example', undefined, 'wrong password!!')).json().error.code).toBe('UNAUTHORIZED');

    expect((await login('agent@streamco.example', '123456')).json().error.code).toBe('UNAUTHORIZED');
    const code = totpCode(secret, clock.now());
    expect((await login('agent@streamco.example', code)).statusCode).toBe(200);
    // The same code again (replay) is refused.
    expect((await login('agent@streamco.example', code)).statusCode).toBe(401);
  });

  it('keeps the secret sealed at rest', async () => {
    const { secret } = await enrol('agent@streamco.example');
    const [row] = await ctx.db.select().from(dashboardUsers).where(eq(dashboardUsers.email, 'agent@streamco.example'));
    expect(row!.totpSecret).toBeTruthy();
    expect(row!.totpSecret).not.toContain(secret);
    expect(row!.totpPendingSecret).toBeNull();
  });

  it('turns off only with the password and a current code', async () => {
    const { secret, cookie } = await enrol('agent@streamco.example');
    expect((await as(cookie, 'POST', '/dashboard/api/me/2fa/disable', { password: 'wrong password!!', code: totpCode(secret, clock.now()) })).statusCode).toBe(401);
    expect((await as(cookie, 'POST', '/dashboard/api/me/2fa/disable', { password: PW, code: '000000' })).statusCode).toBe(401);
    expect((await as(cookie, 'POST', '/dashboard/api/me/2fa/disable', { password: PW, code: totpCode(secret, clock.now()) })).statusCode).toBe(200);
    expect((await login('agent@streamco.example')).statusCode).toBe(200);
  });

  it('lets an admin reset a team member who lost their phone, and records it', async () => {
    await enrol('agent@streamco.example');
    const admin = cookieOf(await login('admin@streamco.example'));
    const users = (await as(admin, 'GET', '/dashboard/api/users')).json().data;
    const agent = users.find((u: { email: string }) => u.email === 'agent@streamco.example');
    expect(agent.twoFactor).toBe(true);
    const res = await as(admin, 'PATCH', `/dashboard/api/users/${agent.id}`, { twoFactor: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().twoFactor).toBe(false);
    expect((await login('agent@streamco.example')).statusCode).toBe(200);
    // Turning it on for someone else is not possible: only the user can enrol their own device.
    expect((await as(admin, 'PATCH', `/dashboard/api/users/${agent.id}`, { twoFactor: true })).statusCode).toBe(400);

    const types = (await ctx.db.select({ type: paymentEvents.type }).from(paymentEvents)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED']));
  });

  it('a session started before two-factor was turned on keeps working; others end on enrolment', async () => {
    const other = cookieOf(await login('agent@streamco.example'));
    const { cookie } = await enrol('agent@streamco.example');
    expect((await as(cookie, 'GET', '/dashboard/api/me')).statusCode).toBe(200);
    expect((await as(other, 'GET', '/dashboard/api/me')).statusCode).toBe(401);
  });
});
