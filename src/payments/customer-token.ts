import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bearer token that lets a checkout page read the customer-safe status of exactly one payment.
 * Derived (not stored) so an idempotent replay of payment creation returns the same token.
 * Grants nothing else: no dashboard access, no other payments, no internal detail.
 */
export function customerToken(secret: string, paymentId: string): string {
  return createHmac('sha256', secret).update(`cst:v1:${paymentId}`).digest('base64url');
}

export function verifyCustomerToken(secret: string, paymentId: string, token: string): boolean {
  const expected = Buffer.from(customerToken(secret, paymentId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
