import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { paymentEvents } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN_TOKEN = 'test-admin-token-123';
const PW = 'correct horse battery';

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword(PW);
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
    expect(await verifyPassword(PW, 'garbage')).toBe(false);
  });
});

describe('dashboard authentication & roles', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let apiKey: string;

  async function setup(secureCookies = false) {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN_TOKEN, clock, sleep: clock.sleep, secureCookies });
    app = buildApp(ctx);
    const res = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name: 'StreamCo' } });
    apiKey = res.json().apiKey;
  }

  const bootstrap = (email: string, role: string, password = PW) =>
    app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${apiKey}` }, payload: { email, name: email.split('@')[0], password, role } });
  const login = (email: string, password = PW) =>
    app.inject({ method: 'POST', url: '/dashboard/api/login', headers: { 'x-dashboard-request': '1' }, payload: { email, password } });
  const cookieOf = (res: Awaited<ReturnType<typeof login>>) => {
    const c = res.cookies.find((x) => x.name === 'rs_session');
    if (!c) throw new Error('no session cookie');
    return `rs_session=${c.value}`;
  };
  const as = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie, ...(method === 'GET' ? {} : { 'x-dashboard-request': '1' }) } });

  describe('sessions', () => {
    beforeEach(() => setup());

    it('bootstraps an admin with the API key, then logs in with an httpOnly SameSite=Strict cookie', async () => {
      const created = await bootstrap('Owner@StreamCo.example', 'ADMIN');
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ email: 'owner@streamco.example', role: 'ADMIN' });
      expect(created.json()).not.toHaveProperty('passwordHash');

      const res = await login('owner@streamco.example');
      expect(res.statusCode).toBe(200);
      const c = res.cookies.find((x) => x.name === 'rs_session')!;
      expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
      expect(c.secure).toBeFalsy();

      const me = await as(cookieOf(res), 'GET', '/dashboard/api/me');
      expect(me.json()).toMatchObject({ user: { email: 'owner@streamco.example', role: 'ADMIN' }, merchant: { name: 'StreamCo' } });
    });

    it('rejects duplicate emails and short passwords', async () => {
      await bootstrap('a@x.example', 'ADMIN');
      expect((await bootstrap('A@x.example', 'VIEWER')).statusCode).toBe(409);
      expect((await bootstrap('b@x.example', 'VIEWER', 'short')).statusCode).toBe(400);
    });

    it('requires a session', async () => {
      expect((await app.inject({ method: 'GET', url: '/dashboard/api/me' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/dashboard/api/me', headers: { cookie: 'rs_session=forged' } })).statusCode).toBe(401);
    });

    it('rejects bad passwords and locks the account after 5 failures', async () => {
      await bootstrap('ops@x.example', 'SUPPORT');
      expect((await login('ops@x.example', 'nope')).statusCode).toBe(401);
      expect((await login('nobody@x.example', 'nope')).statusCode).toBe(401);
      for (let i = 0; i < 4; i++) await login('ops@x.example', 'nope');
      const locked = await login('ops@x.example');
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('ACCOUNT_LOCKED');
      clock.advance(15 * 60_000);
      expect((await login('ops@x.example')).statusCode).toBe(200);
    });

    it('expires idle sessions after 30 minutes and all sessions after 12 hours', async () => {
      await bootstrap('ops@x.example', 'SUPPORT');
      const idle = cookieOf(await login('ops@x.example'));
      clock.advance(30 * 60_000);
      expect((await as(idle, 'GET', '/dashboard/api/me')).statusCode).toBe(401);

      // Active every 20 minutes: never idle, but the absolute 12h limit still applies.
      const active = cookieOf(await login('ops@x.example'));
      for (let i = 0; i < 35; i++) {
        clock.advance(20 * 60_000);
        expect((await as(active, 'GET', '/dashboard/api/me')).statusCode).toBe(200);
      }
      clock.advance(20 * 60_000); // exactly 12h after login
      expect((await as(active, 'GET', '/dashboard/api/me')).statusCode).toBe(401);
    });

    it('logout revokes the session', async () => {
      await bootstrap('ops@x.example', 'SUPPORT');
      const c = cookieOf(await login('ops@x.example'));
      expect((await as(c, 'POST', '/dashboard/api/logout')).statusCode).toBe(200);
      expect((await as(c, 'GET', '/dashboard/api/me')).statusCode).toBe(401);
    });

    it('requires the CSRF header on state-changing requests', async () => {
      await bootstrap('ops@x.example', 'ADMIN');
      const res = await app.inject({ method: 'POST', url: '/dashboard/api/login', payload: { email: 'ops@x.example', password: PW } });
      expect(res.statusCode).toBe(403);
      const c = cookieOf(await login('ops@x.example'));
      const noHeader = await app.inject({ method: 'POST', url: '/dashboard/api/users', headers: { cookie: c }, payload: {} });
      expect(noHeader.statusCode).toBe(403);
    });

    it('audits user creation and logins', async () => {
      await bootstrap('ops@x.example', 'ADMIN');
      await login('ops@x.example', 'bad');
      await login('ops@x.example');
      const types = (await ctx.db.select().from(paymentEvents)).map((e) => [e.type, e.actorType]);
      expect(types).toEqual(expect.arrayContaining([['USER_CREATED', 'API_KEY'], ['LOGIN_FAILED', 'DASHBOARD_USER'], ['LOGIN_SUCCEEDED', 'DASHBOARD_USER']]));
    });
  });

  it('sets the Secure flag when configured for HTTPS', async () => {
    await setup(true);
    await bootstrap('ops@x.example', 'ADMIN');
    expect((await login('ops@x.example')).cookies.find((x) => x.name === 'rs_session')!.secure).toBe(true);
  });

  describe('user management roles', () => {
    let admin: string;
    let support: string;
    let viewer: string;

    beforeEach(async () => {
      await setup();
      await bootstrap('admin@x.example', 'ADMIN');
      await bootstrap('support@x.example', 'SUPPORT');
      await bootstrap('viewer@x.example', 'VIEWER');
      admin = cookieOf(await login('admin@x.example'));
      support = cookieOf(await login('support@x.example'));
      viewer = cookieOf(await login('viewer@x.example'));
    });

    it('only admins can list, create and update users', async () => {
      const newUser = { email: 'new@x.example', name: 'New', password: PW, role: 'VIEWER' };
      for (const c of [support, viewer]) {
        expect((await as(c, 'GET', '/dashboard/api/users')).statusCode).toBe(403);
        expect((await as(c, 'POST', '/dashboard/api/users', newUser)).statusCode).toBe(403);
      }
      expect((await as(admin, 'GET', '/dashboard/api/users')).json().data).toHaveLength(3);
      const created = await as(admin, 'POST', '/dashboard/api/users', newUser);
      expect(created.statusCode).toBe(201);
      const patched = await as(admin, 'PATCH', `/dashboard/api/users/${created.json().id}`, { role: 'SUPPORT' });
      expect(patched.json().role).toBe('SUPPORT');
    });

    it('disabling a user ends their sessions and blocks login', async () => {
      const users = (await as(admin, 'GET', '/dashboard/api/users')).json().data as Array<{ id: string; email: string }>;
      const sup = users.find((u) => u.email === 'support@x.example')!;
      await as(admin, 'PATCH', `/dashboard/api/users/${sup.id}`, { disabled: true });
      expect((await as(support, 'GET', '/dashboard/api/me')).statusCode).toBe(401);
      expect((await login('support@x.example')).statusCode).toBe(401);
    });

    it('a merchant always keeps at least one active admin', async () => {
      const users = (await as(admin, 'GET', '/dashboard/api/users')).json().data as Array<{ id: string; email: string }>;
      const me = users.find((u) => u.email === 'admin@x.example')!;
      const res = await as(admin, 'PATCH', `/dashboard/api/users/${me.id}`, { role: 'VIEWER' });
      expect(res.statusCode).toBe(409);
    });

    it('users from another merchant are invisible', async () => {
      const other = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, payload: { name: 'Other' } });
      const otherKey = other.json().apiKey;
      const u = await app.inject({
        method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${otherKey}` },
        payload: { email: 'x@other.example', name: 'X', password: PW, role: 'ADMIN' },
      });
      expect((await as(admin, 'PATCH', `/dashboard/api/users/${u.json().id}`, { role: 'VIEWER' })).statusCode).toBe(404);
      const [ev] = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.actorId, u.json().id));
      expect(ev).toBeUndefined();
    });
  });
});
