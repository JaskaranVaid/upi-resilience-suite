import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { totpCode } from '../../src/auth/totp.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import type { OperatorRole } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';
const CSRF = { 'x-ops-request': '1' };

describe('ops console API', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, secureCookies: true });
    app = buildApp(ctx);
  });

  async function signIn(role: OperatorRole = 'OPERATOR', email = `${role.toLowerCase()}@merchantflo.in`) {
    const { password, otpauthUri } = await ctx.operators.create({ email, name: role, role }, null);
    const secret = new URL(otpauthUri).searchParams.get('secret')!;
    const res = await app.inject({ method: 'POST', url: '/ops/api/login', headers: CSRF, payload: { email, password, code: totpCode(secret, clock.now()) } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'mf_ops')!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/ops' });
    return { cookie: `mf_ops=${cookie.value}`, password, secret };
  }

  const as = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { cookie, ...(method === 'POST' ? CSRF : {}) } });

  it('requires a signed-in operator for everything but login', async () => {
    for (const url of ['/ops/api/me', '/ops/api/pauses', '/ops/api/metrics', '/ops/api/audit', '/ops/api/merchants']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    // A merchant API key or the admin token is not an operator session.
    expect((await app.inject({ method: 'GET', url: '/ops/api/me', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode).toBe(401);
  });

  it('signs in with password and code, then knows who you are; logout ends the session', async () => {
    const { cookie } = await signIn();
    expect((await as(cookie, 'GET', '/ops/api/me')).json()).toMatchObject({ operator: { email: 'operator@merchantflo.in', role: 'OPERATOR' } });
    expect((await as(cookie, 'POST', '/ops/api/logout')).statusCode).toBe(200);
    expect((await as(cookie, 'GET', '/ops/api/me')).statusCode).toBe(401);
  });

  it('refuses state changes without the CSRF header', async () => {
    const { cookie } = await signIn();
    const res = await app.inject({ method: 'POST', url: '/ops/api/pauses', headers: { cookie }, payload: { scope: 'GLOBAL', reason: 'x' } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/ops/api/login', payload: { email: 'a@b.c', password: 'x', code: '000000' } })).statusCode).toBe(403);
  });

  it('pauses and lifts through the API, and the audit log shows it', async () => {
    const { cookie } = await signIn();
    const created = await as(cookie, 'POST', '/ops/api/pauses', { scope: 'PSP', target: 'pspA', reason: 'pspA timing out' });
    expect(created.statusCode).toBe(201);
    const pause = created.json();
    expect((await as(cookie, 'GET', '/ops/api/pauses')).json().data.map((p: { id: string }) => p.id)).toEqual([pause.id]);
    expect((await as(cookie, 'GET', '/ops/api/metrics')).json()).toMatchObject({ executionPausesActive: 1 });

    expect((await as(cookie, 'POST', `/ops/api/pauses/${pause.id}/lift`)).statusCode).toBe(200);
    expect((await as(cookie, 'GET', '/ops/api/pauses')).json().data).toEqual([]);
    expect((await as(cookie, 'GET', '/ops/api/pauses?include=recent')).json().data[0]).toMatchObject({ id: pause.id, liftedAt: expect.any(String) });

    const entries = (await as(cookie, 'GET', '/ops/api/audit')).json().data;
    expect(entries.slice(0, 3).map((a: { action: string }) => a.action)).toEqual(['EXECUTION_RESUMED', 'EXECUTION_PAUSED', 'LOGIN_SUCCEEDED']);
    expect(entries[0]).toMatchObject({ operatorEmail: 'operator@merchantflo.in', target: `PSP:pspA` });
    expect(entries.at(-1)).toMatchObject({ action: 'OPERATOR_CREATED', operatorEmail: null });
  });

  it('lets a viewer look but not pause', async () => {
    const { cookie } = await signIn('VIEWER');
    expect((await as(cookie, 'GET', '/ops/api/pauses')).statusCode).toBe(200);
    expect((await as(cookie, 'GET', '/ops/api/audit')).statusCode).toBe(200);
    expect((await as(cookie, 'POST', '/ops/api/pauses', { scope: 'GLOBAL', reason: 'x' })).statusCode).toBe(403);
  });

  it('lists merchants to choose a pause target', async () => {
    await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'StreamCo' } });
    const { cookie } = await signIn();
    const res = await as(cookie, 'GET', '/ops/api/merchants?q=stream');
    expect(res.json().data).toEqual([expect.objectContaining({ name: 'StreamCo', mode: 'TEST' })]);
  });

  it('changes the password: the old one stops working, other sessions end, this one stays', async () => {
    const { cookie, password, secret } = await signIn();
    clock.advance(30_000);
    const other = await app.inject({ method: 'POST', url: '/ops/api/login', headers: CSRF, payload: { email: 'operator@merchantflo.in', password, code: totpCode(secret, clock.now()) } });
    const otherCookie = `mf_ops=${other.cookies.find((c) => c.name === 'mf_ops')!.value}`;
    const next = 'a-much-longer-new-passphrase';
    expect((await as(cookie, 'POST', '/ops/api/me/password', { current: 'wrong', next })).statusCode).toBe(401);
    expect((await as(cookie, 'POST', '/ops/api/me/password', { current: password, next: 'short' })).statusCode).toBe(400);
    expect((await as(cookie, 'POST', '/ops/api/me/password', { current: password, next })).statusCode).toBe(200);
    expect((await as(cookie, 'GET', '/ops/api/me')).statusCode).toBe(200);
    expect((await as(otherCookie, 'GET', '/ops/api/me')).statusCode).toBe(401);
    clock.advance(30_000);
    const login = (pw: string) =>
      app.inject({ method: 'POST', url: '/ops/api/login', headers: CSRF, payload: { email: 'operator@merchantflo.in', password: pw, code: totpCode(secret, clock.now()) } });
    expect((await login(password)).statusCode).toBe(401);
    clock.advance(30_000);
    expect((await login(next)).statusCode).toBe(200);
  });
});

describe('ops console static files', () => {
  const opsDir = fileURLToPath(new URL('../../ops', import.meta.url));

  it('serves the console with a strict content security policy', async () => {
    const { db } = await freshDb();
    const app = buildApp(buildContext({ db, adapters: [], adminToken: ADMIN }));
    const res = await app.inject({ method: 'GET', url: '/ops/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.body).toContain('<script type="module" src="./app.js">');
  });

  it('has no inline scripts or styles, and its module parses', () => {
    const html = readFileSync(join(opsDir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=|<style/);
    for (const f of readdirSync(opsDir).filter((n) => n.endsWith('.js'))) {
      execFileSync(process.execPath, ['--check', join(opsDir, f)]);
    }
  });
});
