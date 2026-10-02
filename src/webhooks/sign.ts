import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signature over `${unixSeconds}.${body}` so a captured payload can't be replayed with a new timestamp. */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verify(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
