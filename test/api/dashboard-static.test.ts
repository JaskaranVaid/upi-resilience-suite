import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { buildContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb } from '../helpers/fixtures.js';

const dashboardDir = fileURLToPath(new URL('../../dashboard', import.meta.url));
const jsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });

describe('static dashboard', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const { db } = await freshDb();
    app = buildApp(buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20) }));
  });

  it('serves the shell with a strict content security policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<script type="module" src="./app.js">');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });

  it('serves ES modules and styles', async () => {
    for (const [url, type] of [['/dashboard/app.js', /javascript/], ['/dashboard/views/cases.js', /javascript/], ['/dashboard/styles.css', /text\/css/]] as const) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(type);
    }
  });

  it('redirects /dashboard and 404s unknown assets without shadowing the API', async () => {
    expect((await app.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/dashboard/nope.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/dashboard/api/me' })).statusCode).toBe(401);
  });

  it('contains no inline styles or scripts (they would be blocked by the CSP)', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/' });
    expect(res.body).not.toMatch(/<script>(?!<\/script>)|style="/);
    for (const f of jsFiles(dashboardDir)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/style="/);
    }
  });

  it('every dashboard module parses', () => {
    for (const f of jsFiles(dashboardDir)) {
      expect(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }), f).not.toThrow();
    }
  });
});
