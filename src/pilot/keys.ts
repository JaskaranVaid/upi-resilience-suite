import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { debits, shadowDebits } from '../db/schema.js';

/**
 * One idempotency key names at most one debit, live (`debits`) or shadow (`shadow_debits`). Each
 * table's unique index guards itself; across the two, every insert takes this transaction-scoped
 * lock on (merchant, key) and then checks the other table, so two requests racing around a stage
 * change can't create one of each. (Merchant ids contain no ":", so the key text is unambiguous.)
 */
export async function lockDebitKey(tx: DbOrTx, merchantId: string, key: string): Promise<void> {
  // Merchant ids never contain ":", so "<merchant>:<key>" names one (merchant, key) pair.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${merchantId}:${key}`}, 7))`);
}

/** Thrown when the key is already taken in the other table; intake then replays that debit. */
export class DebitKeyTaken extends Error {
  override name = 'DebitKeyTaken';
  constructor(readonly by: 'LIVE' | 'SHADOW') {
    super(by === 'SHADOW' ? 'Idempotency key already names a shadow debit (executed by the merchant)' : 'Idempotency key already names a debit Merchantflo executes');
  }
}

export async function liveKeyExists(tx: DbOrTx, merchantId: string, key: string): Promise<boolean> {
  const [d] = await tx.select({ id: debits.id }).from(debits).where(and(eq(debits.merchantId, merchantId), eq(debits.idempotencyKey, key)));
  return Boolean(d);
}

export async function shadowKeyExists(tx: DbOrTx, merchantId: string, key: string): Promise<boolean> {
  const [s] = await tx.select({ id: shadowDebits.id }).from(shadowDebits).where(and(eq(shadowDebits.merchantId, merchantId), eq(shadowDebits.idempotencyKey, key)));
  return Boolean(s);
}
