import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { debits, payments, type paymentCases, type paymentTracking } from '../db/schema.js';

type Tracking = typeof paymentTracking.$inferSelect;
type PaymentCase = typeof paymentCases.$inferSelect;

/**
 * Merchant-facing payload for money-movement and case events. Built from canonical facts only;
 * internal detail (PSP codes, check counts, backoff) never leaves the backend.
 */
export async function paymentFactsPayload(db: DbOrTx, t: Tracking, c?: PaymentCase | null) {
  const subject =
    t.subjectType === 'COLLECT'
      ? (await db.select({ orderId: payments.orderId, amountPaise: payments.amountPaise }).from(payments).where(eq(payments.id, t.subjectId)))[0]
      : (await db.select({ orderId: debits.orderId, amountPaise: debits.amountPaise }).from(debits).where(eq(debits.id, t.subjectId)))[0];
  return {
    paymentType: t.subjectType,
    paymentId: t.subjectId,
    orderId: subject?.orderId ?? null,
    amountPaise: subject?.amountPaise ?? null,
    upiRrn: t.upiRrn,
    customerDebit: t.customerDebit,
    capture: t.capture,
    reversal: { status: t.reversalStatus, initiatedAt: t.reversalInitiatedAt, completedAt: t.reversalCompletedAt },
    ...(c ? { case: { id: c.id, reason: c.reason, status: c.status, resolution: c.resolution } } : {}),
  };
}
