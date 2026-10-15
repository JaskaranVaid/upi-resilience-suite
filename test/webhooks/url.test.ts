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
    // IPv6 forms that embed an IPv4 address — each must be judged by the address inside.
    ['::ffff:a9fe:a9fe', true], // mapped 169.254.169.254, as the URL parser serialises it
    ['0:0:0:0:0:ffff:10.0.0.1', true],
    ['::ffff:808:808', false], // mapped 8.8.8.8
    ['::127.0.0.1', true], // deprecated IPv4-compatible
    ['64:ff9b::a00:1', true], // NAT64 of 10.0.0.1
    ['64:ff9b::808:808', false], // NAT64 of 8.8.8.8
    ['2002:a00:1::', true], // 6to4 of 10.0.0.1
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', true], // Teredo
    ['fec0::1', true], // site-local
    ['2001:db8::1', true], // documentation
    ['100::1', true], // discard-only
    ['fe80::1%eth0', true], // zoned link-local
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
    expect(checkWebhookUrl('https://[::ffff:169.254.169.254]/latest', 'public-only')).toMatch(/private/);
    expect(checkWebhookUrl('https://[0:0:0:0:0:ffff:10.0.0.1]/', 'public-only')).toMatch(/private/);
    expect(checkWebhookUrl('https://[::127.0.0.1]/', 'public-only')).toMatch(/private/);
    expect(checkWebhookUrl('https://2130706433/', 'public-only')).toMatch(/private/); // decimal 127.0.0.1
    expect(checkWebhookUrl('https://localhost./hooks', 'public-only')).toMatch(/public host/); // trailing dot
    expect(checkWebhookUrl('https://user:pass@merchant.example/hooks', 'any')).toMatch(/credentials/);
  });

  it('refuses delivery when a public-looking name resolves to a private address', async () => {
    const guard = publicTargetGuard(async (host) => (host === 'rebound.example' ? ['10.0.0.5'] : ['13.234.10.1']));
    expect(await guard('https://ok.example/hooks')).toBeNull();
    expect(await guard('https://rebound.example/hooks')).toMatch(/non-public address \(10\.0\.0\.5\)/);
    await expect(publicTargetGuard(async () => [])('https://gone.example/hooks')).rejects.toThrow(/did not resolve/);
  });
});
