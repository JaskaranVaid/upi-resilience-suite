import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s) — what Google
 * Authenticator, 1Password, Authy etc. generate. No dependency beyond node:crypto.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerates lower case, spaces and padding, as people copy secrets out of apps. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps expect). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}

export const stepOf = (at: Date) => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

export function totpCode(secret: string, at: Date, opts: { digits?: number } = {}): string {
  return hotp(base32Decode(secret), stepOf(at), opts.digits ?? 6);
}

/**
 * The time step a 6-digit code belongs to (now, or one step either side for clock drift), or null.
 * A step at or before `lastUsedStep` is refused, so a code can't be replayed — store the returned
 * step as the new lastUsedStep.
 */
export function verifyTotp(secret: string, code: string, at: Date, lastUsedStep: number | null, window = 1): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const key = base32Decode(secret);
  const now = stepOf(at);
  let match: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    // Compare every candidate (constant work) rather than returning on the first match.
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(given)) && (lastUsedStep === null || step > lastUsedStep)) match ??= step;
  }
  return match;
}

export function otpauthUri(o: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(o.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(o.account)}?secret=${o.secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
