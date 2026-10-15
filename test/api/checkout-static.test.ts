import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { buildContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb } from '../helpers/fixtures.js';

const widgetPath = fileURLToPath(new URL('../../checkout/v1/checkout.js', import.meta.url));

describe('checkout.js static assets', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const { db } = await freshDb();
    app = buildApp(buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20) }));
  });

  it('serves the widget and its stylesheet so any merchant origin can load them', async () => {
    for (const [url, type] of [['/checkout/v1/checkout.js', /javascript/], ['/checkout/v1/checkout.css', /text\/css/]] as const) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(type);
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
    }
  });

  it('serves the demo page with a strict content security policy and no inline script', async () => {
    const res = await app.inject({ method: 'GET', url: '/checkout/demo.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.body).toContain('src="./v1/checkout.js"');
    expect(res.body).not.toMatch(/<script>(?!<\/script>)|style="/);
  });

  it('404s unknown assets and leaves the public checkout API alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/checkout/v1/nope.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/public/checkout/sessions/cks_x', headers: { 'x-checkout-token': 'x' } })).statusCode).toBe(404);
  });

  it('the widget parses and needs no inline styles (merchant CSPs often block them)', () => {
    execFileSync(process.execPath, ['--check', widgetPath], { stdio: 'pipe' });
    const src = readFileSync(widgetPath, 'utf8');
    expect(src).not.toMatch(/<style|style="/);
  });

  it('only lets payment links with safe schemes reach href or location', () => {
    const window: { Merchantflo?: { safeUrl: (u: string) => string | null; version: string } } = {};
    runInNewContext(readFileSync(widgetPath, 'utf8'), { window, document: { currentScript: null } });
    const { safeUrl } = window.Merchantflo!;
    expect(window.Merchantflo!.version).toBe('1');
    for (const ok of ['upi://pay?pa=a@b&am=1', 'https://bank.example/nb', 'phonepe://pay?pa=a@b', 'tez://upi/pay?pa=a@b', 'paytmmp://pay?pa=a@b', 'intent://pay#Intent;scheme=upi;end']) {
      expect(safeUrl(ok), ok).toBe(ok);
    }
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'http://bank.example/nb', '//evil.example', 'file:///etc/passwd', '']) {
      expect(safeUrl(bad), bad).toBeNull();
    }
  });
});
