import { and, desc, eq, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { webhookOutbox } from '../db/schema.js';
import { AppError } from '../errors.js';

type Row = typeof webhookOutbox.$inferSelect;
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export function deliveryView(r: Row) {
  const status: DeliveryStatus = r.deliveredAt ? 'delivered' : r.deadAt ? 'failed' : 'pending';
  return {
    id: r.id,
    event: r.event,
    status,
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt,
    /** When delivery was given up (attempts exhausted, or the URL was refused). */
    failedAt: r.deadAt,
    /** Next attempt, while pending. */
    nextAttemptAt: status === 'pending' ? r.nextAttemptAt : null,
    data: r.payload,
  };
}

/** The webhook delivery log (the outbox, as the merchant sees it), and redelivery. */
export class WebhookDeliveryService {
  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  async list(merchantId: string, q: { status?: DeliveryStatus; event?: string; before?: string; limit: number }) {
    const { db } = this.deps;
    const conds: (SQL | undefined)[] = [eq(webhookOutbox.merchantId, merchantId)];
    if (q.status === 'delivered') conds.push(isNotNull(webhookOutbox.deliveredAt));
    if (q.status === 'failed') conds.push(isNotNull(webhookOutbox.deadAt));
    if (q.status === 'pending') conds.push(isNull(webhookOutbox.deliveredAt), isNull(webhookOutbox.deadAt));
    if (q.event) conds.push(eq(webhookOutbox.event, q.event));
    if (q.before) {
      const [b] = await db.select({ createdAt: webhookOutbox.createdAt }).from(webhookOutbox).where(and(eq(webhookOutbox.id, q.before), eq(webhookOutbox.merchantId, merchantId)));
      if (!b) throw new AppError('VALIDATION', 'Unknown "before" cursor');
      conds.push(or(lt(webhookOutbox.createdAt, b.createdAt), and(eq(webhookOutbox.createdAt, b.createdAt), lt(webhookOutbox.id, q.before))));
    }
    const rows = await db
      .select()
      .from(webhookOutbox)
      .where(and(...conds))
      .orderBy(desc(webhookOutbox.createdAt), desc(webhookOutbox.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { data: page.map(deliveryView), nextBefore: rows.length > q.limit ? page.at(-1)!.id : null };
  }

  /**
   * Send a delivered or failed webhook again: same id and payload, signed afresh (current time and
   * secret) by the dispatcher on its next run, with a full retry budget. A pending one is already
   * queued; resetting it could race an in-flight attempt, so that is a conflict.
   */
  async redeliver(merchantId: string, id: string) {
    const { db, clock } = this.deps;
    const [row] = await db
      .update(webhookOutbox)
      .set({ deliveredAt: null, deadAt: null, attempts: 0, lastError: null, nextAttemptAt: clock.now() })
      .where(and(eq(webhookOutbox.id, id), eq(webhookOutbox.merchantId, merchantId), or(isNotNull(webhookOutbox.deliveredAt), isNotNull(webhookOutbox.deadAt))))
      .returning();
    if (row) return deliveryView(row);
    const [exists] = await db.select({ id: webhookOutbox.id }).from(webhookOutbox).where(and(eq(webhookOutbox.id, id), eq(webhookOutbox.merchantId, merchantId)));
    if (!exists) throw new AppError('NOT_FOUND', 'Webhook delivery not found');
    throw new AppError('CONFLICT', 'This webhook is still being delivered — it is already queued');
  }
}
