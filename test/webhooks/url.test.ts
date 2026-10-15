import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, isNonPublicAddress, publicTargetGuard } from '../../src/webhooks/url.js';

describe('webhook target safety', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.9', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata service
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['13.234.10.1', false],
    ['::1', true],
    ['fe80::1', true],
    ['fd12:3456::1', true],
    ['::ffff:10.0.0.1', true],
    ['2606:4700::1111', false],
  ])('%s non-public=%s', (ip, expected) => {
    expect(isNonPublicAddress(ip)).toBe(expected);
  });

  it('allows any http(s) URL under the permissive policy (local development)', () => {
    expect(checkWebhookUrl('http://localhost:4000/hooks', 'any')).toBeNull();
    expect(checkWebhookUrl('ftp://example.com', 'any')).toMatch(/http/);
    expect(checkWebhookUrl('not a url', 'any')).toMatch(/valid URL/);
  });

  it('requires https and a public host under the production policy', () => {
    expect(checkWebhookUrl('https://hooks.merchant.example/upi', 'public-only')).toBeNull();
    expect(checkWebhookUrl('http://hooks.merchant.example/upi', 'public-only')).toMatch(/https/);
    expect(checkWebhookUrl('https://localhost/hooks', 'public-only')).toMatch(/public host/);
    expect(checkWebhookUrl('https://billing.internal/hooks', 'public-only')).toMatch(/public host/);
    expect(checkWebhookUrl('https://169.254.169.254/latest/meta-data', 'public-only')).toMatch(/private/);
    expect(checkWebhookUrl('https://[::1]/hooks', 'public-only')).toMatch(/private/);
    expect(checkWebhookUrl('https://user:pass@merchant.example/hooks', 'any')).toMatch(/credentials/);
  });

  it('refuses delivery when a public-looking name resolves to a private address', async () => {
    const guard = publicTargetGuard(async (host) => (host === 'rebound.example' ? ['10.0.0.5'] : ['13.234.10.1']));
    expect(await guard('https://ok.example/hooks')).toBeNull();
    expect(await guard('https://rebound.example/hooks')).toMatch(/non-public address \(10\.0\.0\.5\)/);
    await expect(publicTargetGuard(async () => [])('https://gone.example/hooks')).rejects.toThrow(/did not resolve/);
  });
});
