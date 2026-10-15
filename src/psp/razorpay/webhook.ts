import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookVerification } from '../types.js';

/**
 * Razorpay signs webhooks as hex(HMAC-SHA256(webhookSecret, rawBody)) in X-Razorpay-Signature.
 * There is no signed timestamp, and Razorpay retries with the same body for hours, so replays can't
 * be rejected by age — harmless here, because a webhook only triggers a status re-check.
 */
export function verifyRazorpayWebhook(secret: string, rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookVerification {
  const raw = headers['x-razorpay-signature'];
  const signature = Array.isArray(raw) ? raw[0] : raw;
  if (!signature) return { ok: false, reason: 'missing signature header' };
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad signature' };
  return { ok: true, refs: extractRefs(rawBody) };
}

/** Our references in Razorpay events: the order receipt, and the merchantflo_ref note we attach. */
export function extractRefs(rawBody: string): string[] {
  let body: { payload?: Record<string, { entity?: Record<string, unknown> }> } | null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const refs = new Set<string>();
  for (const { entity } of Object.values(body?.payload ?? {})) {
    if (!entity) continue;
    if (typeof entity.receipt === 'string') refs.add(entity.receipt);
    const notes = entity.notes as Record<string, unknown> | undefined;
    if (notes && typeof notes.merchantflo_ref === 'string') refs.add(notes.merchantflo_ref);
  }
  return [...refs].filter((r) => r.length > 0);
}
