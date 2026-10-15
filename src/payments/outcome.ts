import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { checkoutQuotes, checkoutSessions, payments } from '../db/schema.js';
import type { MethodsQuote } from '../rules/steering.js';
import { methodOfChannel } from '../checkout/sessions.js';
import { recordEvents, SYSTEM } from '../events/record.js';
import { recordSavings } from '../ledger/savings.js';
import type { PspResult } from '../psp/types.js';
import { enqueueWebhook } from '../webhooks/outbox.js';

export type Payment = typeof payments.$inferSelect;

export function paymentView(p: Payment) {
  return {
    id: p.id,
    orderId: p.orderId,
    amountPaise: p.amountPaise,
    channel: p.channel,
    payerVpa: p.payerVpa,
    state: p.state,
    /** What the customer must do to pay; present while the payment is pending. */
    customerAction: p.state === 'PENDING' ? p.customerAction : null,
    pspId: p.pspId,
    pspTxnId: p.pspTxnId,
    lastErrorCode: p.lastErrorCode,
    quoteId: p.quoteId,
    createdAt: p.createdAt,
  };
}

/**
 * A paid checkout: mark its session paid and, when the customer paid with the method we steered
 * them to, book the MDR saving (net of their discount) — once, since savings are keyed by quote.
 */
async function settleQuote(tx: DbOrTx, p: Payment, now: Date): Promise<void> {
  await tx.update(checkoutSessions).set({ status: 'PAID', updatedAt: now }).where(and(eq(checkoutSessions.paymentId, p.id), eq(checkoutSessions.status, 'OPEN')));
  const [q] = await tx.select().from(checkoutQuotes).where(and(eq(checkoutQuotes.id, p.quoteId!), eq(checkoutQuotes.merchantId, p.merchantId)));
  if (!q || q.paidAt) return;
  const quote = q.quote as MethodsQuote;
  const method = methodOfChannel(p.channel);
  await tx.update(checkoutQuotes).set({ acceptedMethod: method, acceptedAt: q.acceptedAt ?? now, paidAt: now, paymentReference: p.id }).where(eq(checkoutQuotes.id, q.id));
  if (quote.offer?.method === method) {
    await recordSavings(tx, { merchantId: p.merchantId, type: 'MDR_STEERING_ACCEPTED', amountPaise: quote.offer.merchantNetSavingsPaise, refId: q.id, now });
  }
}

/**
 * Apply a PSP result to a PENDING collect: the single place a collect leaves PENDING, whether
 * from the synchronous router call (Phase 2) or the status poller (Phase 3). Emits the
 * Phase 2 webhooks and savings exactly as before. A payment that is no longer PENDING is
 * returned unchanged — FAILED and SUCCEEDED are terminal.
 */
export async function applyPaymentOutcome(
  tx: DbOrTx,
  args: {
    id: string;
    result: PspResult;
    pspId: string | null;
    hadTechnicalDecline: boolean;
    now: Date;
    /** Overrides the normalized code with the PSP's own (internal) failure code. */
    errorCode?: string;
  },
): Promise<Payment> {
  const { id, result, pspId, hadTechnicalDecline, now } = args;
  const state = result.kind === 'SUCCESS' ? 'SUCCEEDED' : result.kind === 'PENDING' ? 'PENDING' : 'FAILED';
  const [row] = await tx
    .update(payments)
    .set({
      state,
      pspId,
      pspTxnId: result.kind === 'SUCCESS' ? result.pspTxnId : null,
      lastErrorCode: args.errorCode ?? ('code' in result ? result.code : null),
      updatedAt: now,
    })
    .where(and(eq(payments.id, id), eq(payments.state, 'PENDING')))
    .returning();
  if (!row) {
    const [current] = await tx.select().from(payments).where(eq(payments.id, id));
    if (!current) throw new Error(`Payment ${id} not found`);
    return current;
  }

  const ctx = { merchantId: row.merchantId, subjectType: 'COLLECT' as const, subjectId: row.id, actor: SYSTEM, now };
  if (state === 'SUCCEEDED') {
    await enqueueWebhook(tx, { merchantId: row.merchantId, event: 'payment.succeeded', payload: paymentView(row), now });
    await recordEvents(tx, ctx, [{ type: 'PAYMENT_STATE_CHANGED', data: { to: 'SUCCEEDED' } }]);
    if (hadTechnicalDecline) {
      await recordSavings(tx, { merchantId: row.merchantId, type: 'TD_RECOVERED', amountPaise: row.amountPaise, refId: row.id, now });
    }
    if (row.quoteId) await settleQuote(tx, row, now);
  } else if (state === 'FAILED') {
    await enqueueWebhook(tx, { merchantId: row.merchantId, event: 'payment.failed', payload: paymentView(row), now });
    await recordEvents(tx, ctx, [{ type: 'PAYMENT_STATE_CHANGED', data: { to: 'FAILED', code: row.lastErrorCode } }]);
  }
  return row;
}
