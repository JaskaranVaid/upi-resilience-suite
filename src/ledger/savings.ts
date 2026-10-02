import { and, count, eq, gte, lt, sum } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { savingsEvents, type SavingsType } from '../db/schema.js';
import { newId } from '../ids.js';

/**
 * Record value the suite created for a merchant. Idempotent per (type, refId) so retries
 * and re-processing never double-count — these numbers are what the merchant is billed on.
 */
export async function recordSavings(
  db: DbOrTx,
  args: { merchantId: string; type: SavingsType; amountPaise: number; refId: string; now: Date },
): Promise<void> {
  await db
    .insert(savingsEvents)
    .values({ id: newId('sav'), merchantId: args.merchantId, type: args.type, amountPaise: args.amountPaise, refId: args.refId, createdAt: args.now })
    .onConflictDoNothing({ target: [savingsEvents.type, savingsEvents.refId] });
}

export interface SavingsSummary {
  byType: Partial<Record<SavingsType, { count: number; amountPaise: number }>>;
  /** Payments that would otherwise have failed: peak-hour rescues + technical-decline recoveries. */
  revenueProtectedPaise: number;
  /** MDR actually avoided through accepted steering offers (net of customer discounts). */
  feesSavedPaise: number;
}

export async function savingsSummary(db: DbOrTx, merchantId: string, from?: Date, to?: Date): Promise<SavingsSummary> {
  const conds = [eq(savingsEvents.merchantId, merchantId)];
  if (from) conds.push(gte(savingsEvents.createdAt, from));
  if (to) conds.push(lt(savingsEvents.createdAt, to));
  const rows = await db
    .select({ type: savingsEvents.type, count: count(), amount: sum(savingsEvents.amountPaise) })
    .from(savingsEvents)
    .where(and(...conds))
    .groupBy(savingsEvents.type);

  const byType: SavingsSummary['byType'] = {};
  for (const r of rows) byType[r.type] = { count: Number(r.count), amountPaise: Number(r.amount ?? 0) };
  const amt = (t: SavingsType) => byType[t]?.amountPaise ?? 0;
  return {
    byType,
    revenueProtectedPaise: amt('PEAK_DEFERRAL_RESCUED') + amt('TD_RECOVERED'),
    feesSavedPaise: amt('MDR_STEERING_ACCEPTED'),
  };
}
