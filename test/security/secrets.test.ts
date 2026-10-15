import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/security/secrets.js';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips a credentials object and never contains the plaintext', () => {
    const box = SecretBox.fromKeyRing(`k1:${key()}`);
    const sealed = box.seal({ clientId: 'CF123', clientSecret: 'cfsk_ma_test_very_secret' });
    expect(sealed).toMatch(/^k1\./);
    expect(sealed).not.toContain('very_secret');
    expect(box.open(sealed)).toEqual({ clientId: 'CF123', clientSecret: 'cfsk_ma_test_very_secret' });
  });

  it('uses a fresh IV per seal', () => {
    const box = SecretBox.fromKeyRing(`k1:${key()}`);
    expect(box.seal({ a: 1 })).not.toBe(box.seal({ a: 1 }));
  });

  it('rejects tampered ciphertext or tag', () => {
    const box = SecretBox.fromKeyRing(`k1:${key()}`);
    const [id, iv, tag, ct] = box.seal({ secret: 'x' }).split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => box.open([id, iv, tag, flip(ct!)].join('.'))).toThrow(/could not be decrypted/);
    expect(() => box.open([id, iv, flip(tag!), ct].join('.'))).toThrow(/could not be decrypted/);
  });

  it('keeps old secrets readable after rotating to a new active key', () => {
    const k1 = key();
    const old = SecretBox.fromKeyRing(`k1:${k1}`).seal({ s: 'old' });
    const rotated = SecretBox.fromKeyRing(`k2:${key()},k1:${k1}`);
    expect(rotated.open(old)).toEqual({ s: 'old' });
    expect(rotated.seal({ s: 'new' })).toMatch(/^k2\./);
    expect(rotated.needsReseal(old)).toBe(true);
  });

  it('explains an unknown key id and malformed key rings', () => {
    const sealed = SecretBox.fromKeyRing(`k1:${key()}`).seal({ s: 1 });
    expect(() => SecretBox.fromKeyRing(`k9:${key()}`).open(sealed)).toThrow(/key k1 is not configured/);
    expect(() => SecretBox.fromKeyRing('k1:dG9vLXNob3J0')).toThrow(/32 bytes/);
    expect(() => SecretBox.fromKeyRing('nonsense')).toThrow(/CREDENTIALS_KEYS/);
    expect(() => SecretBox.fromKeyRing(`k1:${key()},k1:${key()}`)).toThrow(/twice/);
  });

  it('refuses to run in production without a configured key ring', () => {
    expect(() => SecretBox.fromEnv(undefined, 'production')).toThrow(/CREDENTIALS_KEYS is required in production/);
    const warnings: string[] = [];
    const dev = SecretBox.fromEnv(undefined, 'development', (m) => warnings.push(m));
    expect(dev.open(dev.seal({ ok: true }))).toEqual({ ok: true });
    expect(warnings[0]).toMatch(/insecure development key/);
  });
});
