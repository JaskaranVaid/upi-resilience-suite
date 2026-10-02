import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookVerification } from '../types.js';

const MAX_SKEW_MS = 5 * 60_000;

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Cashfree signs webhooks as base64(HMAC-SHA256(clientSecret, x-webhook-timestamp + rawBody)).
 * The raw body must be exactly as received. We also reject stale timestamps (replay window).
 */
export function verifyCashfreeWebhook(
  secret: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  now: Date,
): WebhookVerification {
  const signature = header(headers, 'x-webhook-signature');
  const timestamp = header(headers, 'x-webhook-timestamp');
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const expected = Buffer.from(createHmac('sha256', secret).update(timestamp + rawBody).digest('base64'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad signature' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const tsMs = ts > 1e12 ? ts : ts * 1000; // documented example is milliseconds; accept seconds too
  if (Math.abs(now.getTime() - tsMs) > MAX_SKEW_MS) return { ok: false, reason: 'stale timestamp' };

  return { ok: true, refs: extractRefs(rawBody) };
}

/** Our references that may appear in Cashfree payment, refund and subscription events. */
export function extractRefs(rawBody: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const pick = (o: unknown, key: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined);
  const candidates = [
    pick(pick(data, 'order'), 'order_id'), // payment events
    pick(data, 'order_id'), // auto-refund events
    pick(pick(data, 'refund'), 'order_id'),
    pick(data, 'execution_id'), // controlled execution events
    pick(data, 'payment_id'), // subscription payment events (our debit id)
  ];
  return [...new Set(candidates.filter((c): c is string => typeof c === 'string' && c.length > 0))];
}
