import { and, eq, inArray, or } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { debits, paymentTracking } from '../db/schema.js';
import { SYSTEM } from '../events/record.js';
import type { TrackingService } from '../tracking/service.js';

/**
 * Turns a verified PSP webhook into immediate status re-checks. The payload is never trusted
 * for state: every change still comes from our own PSP lookup through the lease-guarded paths.
 */
export class PspWebhookIngest {
  constructor(private readonly deps: { db: Db; clock: Clock; tracking: TrackingService; log?: (msg: string, err?: unknown) => void }) {}

  async recheck(pspId: string, refs: string[]): Promise<{ matched: number }> {
    if (refs.length === 0) return { matched: 0 };
    const { db, clock, tracking } = this.deps;
    const now = clock.now();

    // Payments we track (collects and executed debits): check now. A busy lease just means a
    // check is already running, which is what we want anyway.
    const tracked = await db
      .select({ id: paymentTracking.id })
      .from(paymentTracking)
      .where(and(eq(paymentTracking.pspId, pspId), inArray(paymentTracking.txnRef, refs)));
    for (const t of tracked) {
      try {
        await tracking.check(t.id, SYSTEM, { manual: false });
      } catch (e) {
        (this.deps.log ?? ((m, err) => console.error(m, err)))(`webhook-triggered check ${t.id} failed`, e);
      }
    }

    // AutoPay debits awaiting confirmation are owned by the Phase 1 worker: bring their next
    // confirmation forward so the worker's next tick looks them up.
    const confirming = await db
      .update(debits)
      .set({ scheduledAt: now, updatedAt: now })
      .where(and(eq(debits.state, 'PENDING_CONFIRMATION'), or(inArray(debits.lastTxnRef, refs), inArray(debits.id, refs))))
      .returning({ id: debits.id });

    return { matched: tracked.length + confirming.length };
  }
}
