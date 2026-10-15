import { and, count, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schemaStatus, type SchemaStatus } from '../db/migrate.js';
import { debits, mandates, merchants, paymentTracking, payments, settlements, webhookOutbox } from '../db/schema.js';

export interface VerifyReport {
  /** Schema current and every invariant holds. */
  ok: boolean;
  schema: SchemaStatus;
  counts: Record<string, number>;
  invariants: Array<{ name: string; violations: number }>;
}

const TABLES = { merchants, mandates, debits, payments, paymentTracking, webhookOutbox, settlements };

/**
 * Check a database is usable: after a restore drill (is the copy complete and consistent?) or
 * before trusting a database someone touched by hand. Read-only.
 */
export async function verifyDatabase(db: Db): Promise<VerifyReport> {
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    const [row] = await db.select({ n: count() }).from(table);
    counts[name] = row?.n ?? 0;
  }

  const violations = async (table: typeof debits | typeof payments | typeof webhookOutbox, where: SQL | undefined) => {
    const [row] = await db.select({ n: count() }).from(table).where(where);
    return row?.n ?? 0;
  };
  const invariants = [
    {
      name: 'terminal debits have completed_at',
      violations: await violations(debits, and(inArray(debits.state, ['SUCCEEDED', 'FAILED']), isNull(debits.completedAt))),
    },
    {
      name: 'succeeded payments and debits carry the PSP transaction id',
      violations:
        (await violations(payments, and(eq(payments.state, 'SUCCEEDED'), isNull(payments.pspTxnId)))) +
        (await violations(debits, and(eq(debits.state, 'SUCCEEDED'), isNull(debits.pspTxnId)))),
    },
    {
      name: 'a webhook is never both delivered and dead',
      violations: await violations(webhookOutbox, and(isNotNull(webhookOutbox.deliveredAt), isNotNull(webhookOutbox.deadAt))),
    },
  ];

  const schema = await schemaStatus(db);
  return { ok: schema.upToDate && invariants.every((i) => i.violations === 0), schema, counts, invariants };
}

/** The same connection URL pointed at another host (a restored instance), credentials and options kept. */
export function withHost(url: string, host: string): string {
  const u = new URL(url);
  u.hostname = host;
  return u.toString();
}
