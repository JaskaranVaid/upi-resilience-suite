import { and, asc, eq, isNull, lt, lte, or } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { paymentTracking } from '../db/schema.js';
import { SYSTEM } from '../events/record.js';
import type { TrackingService } from './service.js';

/**
 * Backend status poller. Finds payments whose next scheduled check is due and runs each
 * through TrackingService.check, whose lease guarantees one check per payment at a time
 * across any number of worker processes. Frontends never poll PSPs.
 */
export class StatusPoller {
  constructor(
    private readonly deps: {
      db: Db;
      clock: Clock;
      tracking: TrackingService;
      log?: (msg: string, err?: unknown) => void;
    },
  ) {}

  /** Run every due check once. Returns how many checks completed. */
  async runOnce(): Promise<number> {
    const { db, clock, tracking } = this.deps;
    const now = clock.now();
    const due = await db
      .select({ id: paymentTracking.id })
      .from(paymentTracking)
      .where(
        and(
          eq(paymentTracking.verificationStatus, 'IN_PROGRESS'),
          lte(paymentTracking.nextCheckAt, now),
          or(isNull(paymentTracking.leaseUntil), lt(paymentTracking.leaseUntil, now)),
        ),
      )
      .orderBy(asc(paymentTracking.nextCheckAt))
      .limit(tracking.config.batchSize);

    let done = 0;
    for (const { id } of due) {
      try {
        if (await tracking.check(id, SYSTEM, { manual: false })) done++;
      } catch (e) {
        (this.deps.log ?? ((m, err) => console.error(m, err)))(`status check ${id} failed`, e);
      }
    }
    return done;
  }
}
