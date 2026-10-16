import { createHmac, timingSafeEqual } from 'node:crypto';

/** Every event Merchantflo sends today; new ones may be added, so ignore events you don't know. */
export type WebhookEventType =
  | 'debit.scheduled'
  | 'debit.notice_sent'
  | 'debit.rescheduled'
  | 'debit.succeeded'
  | 'debit.failed'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.reversal_initiated'
  | 'payment.reversed'
  | 'payment.captured_after_failure'
  | 'case.needs_action'
  | 'case.resolved'
  /** Your pilot moved between shadow, canary and full (`data`: stage, canaryPercent, previousStage, …). */
  | 'pilot.stage_changed';

/** A webhook Merchantflo sent you. `data` depends on `event` (see the integration guide). */
export interface WebhookEvent<T = Record<string, unknown>> {
  /** Delivery id: the same across retries and redeliveries, so use it to ignore duplicates. */
  id: string;
  event: WebhookEventType | (string & {});
  createdAt: string;
  data: T;
}

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
}

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookInput {
  /** The raw request body, exactly as received (before any JSON parsing). */
  payload: string | Uint8Array;
  headers: WebhookHeaders;
  /** Your webhook signing secret (`whsec_…`). */
  secret: string;
  /** Maximum age (and clock skew) accepted, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Current time in Unix seconds (for tests). */
  now?: number;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * Checks a webhook's signature and age, then returns the parsed event. Throws
 * WebhookVerificationError if it was not sent by Merchantflo with your secret, or is too old to trust.
 *
 *   x-resilience-signature: sha256=HMAC_SHA256(secret, "<x-resilience-timestamp>.<raw body>")
 */
export function verifyWebhook<T = Record<string, unknown>>(input: VerifyWebhookInput): WebhookEvent<T> {
  const signature = header(input.headers, 'x-resilience-signature');
  const timestamp = header(input.headers, 'x-resilience-timestamp');
  if (!signature) throw new WebhookVerificationError('Missing x-resilience-signature header');
  if (!timestamp || !/^\d+$/.test(timestamp)) throw new WebhookVerificationError('Missing x-resilience-timestamp header');

  const now = input.now ?? Date.now() / 1000;
  if (Math.abs(now - Number(timestamp)) > (input.toleranceSeconds ?? 300)) throw new WebhookVerificationError('Timestamp outside the tolerance');

  const body = typeof input.payload === 'string' ? input.payload : Buffer.from(input.payload).toString('utf8');
  const expected = Buffer.from(`sha256=${createHmac('sha256', input.secret).update(`${timestamp}.${body}`).digest('hex')}`);
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new WebhookVerificationError('Signature does not match');

  return JSON.parse(body) as WebhookEvent<T>;
}
