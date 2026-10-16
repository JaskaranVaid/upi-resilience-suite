import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openFromRecipient, sealForRecipient } from '../../src/security/handoff.js';

const pair = (bits = 3072) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(), key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};

describe('secret hand-off to a recipient key', () => {
  const alice = pair();

  it('round-trips, and the sealed form reveals nothing', () => {
    const secret = JSON.stringify({ password: 'one-time-PASSWORD-123', otpauthUri: 'otpauth://totp/x?secret=ABCDEF' });
    const blob = sealForRecipient(secret, alice.pub);
    expect(blob).toMatch(/^mfh1\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(blob).not.toMatch(/PASSWORD|otpauth|ABCDEF/);
    expect(openFromRecipient(blob, alice.key)).toBe(secret);
    expect(sealForRecipient(secret, alice.pub)).not.toBe(blob); // randomised
  });

  it('only opens with the matching private key, and refuses tampering', () => {
    const blob = sealForRecipient('hello', alice.pub);
    expect(() => openFromRecipient(blob, pair().key)).toThrow();
    const parts = blob.split('.');
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[4] = ct.toString('base64url');
    expect(() => openFromRecipient(parts.join('.'), alice.key)).toThrow();
    expect(() => openFromRecipient('not a blob', alice.key)).toThrow(/not a sealed hand-off/);
  });

  it('refuses weak or non-RSA recipient keys', () => {
    expect(() => sealForRecipient('x', pair(1024).pub)).toThrow(/at least 2048/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => sealForRecipient('x', ec)).toThrow(/RSA/);
  });
});
