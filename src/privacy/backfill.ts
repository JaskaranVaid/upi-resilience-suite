import { asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import { checkoutSessions, mandates, payments, webhookOutbox } from '../db/schema.js';
import { needsSealing } from '../security/fields.js';

export interface BackfillCounts {
  mandates: number;
  payments: number;
  checkoutSessions: number;
  webhookDeliveries: number;
}

interface Target {
  name: keyof BackfillCounts;
  table: PgTable;
  id: PgColumn;
  /** Personal columns: property name → column. */
  fields: Record<string, PgColumn>;
}

const TARGETS: Target[] = [
  { name: 'mandates', table: mandates, id: mandates.id, fields: { customerVpa: mandates.customerVpa } },
  { name: 'payments', table: payments, id: payments.id, fields: { payerVpa: payments.payerVpa, customerAction: payments.customerAction } },
  { name: 'checkoutSessions', table: checkoutSessions, id: checkoutSessions.id, fields: { customerPhone: checkoutSessions.customerPhone, customerVpa: checkoutSessions.customerVpa } },
  { name: 'webhookDeliveries', table: webhookOutbox, id: webhookOutbox.id, fields: { payload: webhookOutbox.payload } },
];

/**
 * Seal personal fields still stored in plaintext (rows written before encryption) and re-seal
 * those under an older key, in batches. Safe to re-run and to run beside live traffic: each row
 * is rewritten from its own decrypted values. Does nothing while encryption is turned off.
 */
export async function privacyBackfill(db: Db, opts: { batchSize?: number } = {}): Promise<BackfillCounts> {
  const batchSize = opts.batchSize ?? 500;
  const counts: BackfillCounts = { mandates: 0, payments: 0, checkoutSessions: 0, webhookDeliveries: 0 };
  for (const t of TARGETS) {
    let after = '';
    for (;;) {
      // Raw stored values: the same columns selected through a plain SQL alias skip the column's decoder.
      const page = (await db
        .select({ id: t.id, ...Object.fromEntries(Object.entries(t.fields).map(([k, col]) => [k, rawOf(col)])) })
        .from(t.table)
        .where(gt(t.id, after))
        .orderBy(asc(t.id))
        .limit(batchSize)) as Array<Record<string, string | null> & { id: string }>;
      if (page.length === 0) break;
      after = page.at(-1)!.id;

      const stale = page.filter((row) => Object.keys(t.fields).some((k) => needsSealing(row[k] ?? null)));
      if (stale.length === 0) continue;
      const decrypted = (await db
        .select({ id: t.id, ...t.fields })
        .from(t.table)
        .where(inArray(t.id, stale.map((r) => r.id)))) as Array<Record<string, unknown> & { id: string }>;
      // One commit per batch, not per row.
      await db.transaction(async (tx) => {
        for (const { id, ...values } of decrypted) await tx.update(t.table).set(values).where(eq(t.id, id));
      });
      counts[t.name] += decrypted.length;
    }
  }
  return counts;
}

/** The column as stored, always as text: a jsonb string's own text (sealed values), JSON text otherwise. */
function rawOf(col: PgColumn): SQL<unknown> {
  return col.getSQLType() === 'jsonb' ? sql`${col} #>> '{}'` : sql`${col}::text`;
}
