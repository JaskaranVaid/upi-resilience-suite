import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { payments } from '../db/schema.js';
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
  } else if (state === 'FAILED') {
    await enqueueWebhook(tx, { merchantId: row.merchantId, event: 'payment.failed', payload: paymentView(row), now });
    await recordEvents(tx, ctx, [{ type: 'PAYMENT_STATE_CHANGED', data: { to: 'FAILED', code: row.lastErrorCode } }]);
  }
  return row;
}
