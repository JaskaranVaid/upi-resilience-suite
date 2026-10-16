import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUri, totpCode, verifyTotp } from '../../src/auth/totp.js';

// RFC 6238 appendix B uses the ASCII seed "12345678901234567890" (SHA-1) and 8 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const at = (unixSeconds: number) => new Date(unixSeconds * 1000);

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(Buffer.from('12345678901234567890'), counter)).toBe(code));
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 SHA-1 vector at %i s', (t, code) => {
    expect(totpCode(RFC_SECRET, at(t), { digits: 8 })).toBe(code);
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(base32Decode('jbsw y3dp')).toEqual(base32Decode('JBSWY3DP')); // spaces and case from apps
  });

  it('accepts the current code and one step either side, returning the step used', () => {
    const s = generateSecret();
    const now = at(1_800_000_000);
    const step = Math.floor(1_800_000_000 / 30);
    expect(verifyTotp(s, totpCode(s, now), now, null)).toBe(step);
    expect(verifyTotp(s, totpCode(s, at(1_800_000_000 - 30)), now, null)).toBe(step - 1);
    expect(verifyTotp(s, totpCode(s, at(1_800_000_000 + 30)), now, null)).toBe(step + 1);
    expect(verifyTotp(s, totpCode(s, at(1_800_000_000 - 90)), now, null)).toBeNull();
  });

  it('refuses a code from a step already used (replay)', () => {
    const s = generateSecret();
    const now = at(1_800_000_000);
    const used = verifyTotp(s, totpCode(s, now), now, null)!;
    expect(verifyTotp(s, totpCode(s, now), now, used)).toBeNull();
    // The next step's code is still fine.
    expect(verifyTotp(s, totpCode(s, at(1_800_000_030)), at(1_800_000_030), used)).toBe(used + 1);
  });

  it('refuses malformed codes without throwing', () => {
    const s = generateSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56x']) expect(verifyTotp(s, bad, new Date(), null)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    expect(otpauthUri({ issuer: 'Merchantflo Ops', account: 'a@merchantflo.in', secret: 'JBSWY3DPEHPK3PXP' })).toBe(
      'otpauth://totp/Merchantflo%20Ops:a%40merchantflo.in?secret=JBSWY3DPEHPK3PXP&issuer=Merchantflo%20Ops&algorithm=SHA1&digits=6&period=30',
    );
  });
});
