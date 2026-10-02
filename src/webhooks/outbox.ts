import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db, DbOrTx } from '../db/client.js';
import { merchants, webhookOutbox } from '../db/schema.js';
import { newId } from '../ids.js';
import { sign } from './sign.js';

export type WebhookEvent = 'debit.scheduled' | 'debit.succeeded' | 'debit.failed' | 'payment.succeeded' | 'payment.failed';

/** Write a webhook in the caller's transaction so it is emitted iff the state change commits. */
export async function enqueueWebhook(
  db: DbOrTx,
  args: { merchantId: string; event: WebhookEvent; payload: unknown; now: Date },
): Promise<string> {
  const id = newId('whk');
  await db.insert(webhookOutbox).values({
    id,
    merchantId: args.merchantId,
    event: args.event,
    payload: args.payload,
    nextAttemptAt: args.now,
    createdAt: args.now,
  });
  return id;
}

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface DispatcherOptions {
  batchSize?: number;
  maxAttempts?: number;
  /** How long a claimed row stays invisible to other dispatchers while we deliver it. */
  leaseMs?: number;
  requestTimeoutMs?: number;
}

export class WebhookDispatcher {
  private readonly opts: Required<DispatcherOptions>;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly fetchImpl: FetchLike,
    opts: DispatcherOptions = {},
  ) {
    this.opts = { batchSize: 50, maxAttempts: 8, leaseMs: 60_000, requestTimeoutMs: 10_000, ...opts };
  }

  /** Deliver due webhooks once. Returns the number delivered. */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ outbox: webhookOutbox, url: merchants.webhookUrl, secret: merchants.webhookSecret })
        .from(webhookOutbox)
        .innerJoin(merchants, eq(merchants.id, webhookOutbox.merchantId))
        .where(and(isNull(webhookOutbox.deliveredAt), isNull(webhookOutbox.deadAt), lte(webhookOutbox.nextAttemptAt, now)))
        .orderBy(asc(webhookOutbox.nextAttemptAt))
        .limit(this.opts.batchSize)
        .for('update', { of: webhookOutbox, skipLocked: true });
      if (rows.length > 0) {
        await tx
          .update(webhookOutbox)
          .set({ nextAttemptAt: new Date(now.getTime() + this.opts.leaseMs) })
          .where(inArray(webhookOutbox.id, rows.map((r) => r.outbox.id)));
      }
      return rows;
    });

    let delivered = 0;
    for (const { outbox, url, secret } of claimed) {
      const error = url ? await this.deliver(outbox, url, secret) : 'merchant has no webhook URL';
      const attempts = outbox.attempts + 1;
      if (!error) {
        delivered++;
        await this.db.update(webhookOutbox).set({ deliveredAt: this.clock.now(), attempts, lastError: null }).where(eq(webhookOutbox.id, outbox.id));
      } else if (!url || attempts >= this.opts.maxAttempts) {
        await this.db.update(webhookOutbox).set({ deadAt: this.clock.now(), attempts, lastError: error }).where(eq(webhookOutbox.id, outbox.id));
      } else {
        const backoffMs = Math.min(2 ** attempts * 10_000, 3_600_000);
        await this.db
          .update(webhookOutbox)
          .set({ attempts, lastError: error, nextAttemptAt: new Date(this.clock.now().getTime() + backoffMs) })
          .where(eq(webhookOutbox.id, outbox.id));
      }
    }
    return delivered;
  }

  /** Returns an error message, or null on success. */
  private async deliver(row: typeof webhookOutbox.$inferSelect, url: string, secret: string): Promise<string | null> {
    const body = JSON.stringify({ id: row.id, event: row.event, createdAt: row.createdAt.toISOString(), data: row.payload });
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-resilience-event': row.event,
          'x-resilience-delivery': row.id,
          'x-resilience-timestamp': String(timestamp),
          'x-resilience-signature': sign(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
      });
      return res.ok ? null : `HTTP ${res.status}`;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}
