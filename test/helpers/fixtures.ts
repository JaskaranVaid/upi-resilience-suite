import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../../src/db/client.js';
import { mandates, merchants } from '../../src/db/schema.js';
import { DEFAULT_STEERING } from '../../src/rules/steering.js';
import { newId } from '../../src/ids.js';

export const ist = (s: string) => new Date(`${s}+05:30`);
export const rs = (n: number) => Math.round(n * 100);

export async function testDb() {
  return createDb();
}

let shared: Promise<DbHandle> | undefined;

/**
 * One migrated PGlite per test file (booting WASM Postgres costs seconds), wiped between
 * tests. Callers must not close() it — vitest tears the worker down after the file.
 */
export async function freshDb(): Promise<DbHandle> {
  shared ??= createDb();
  const h = await shared;
  await h.db.execute(sql`
    do $$ declare t text; begin
      select string_agg(format('%I', tablename), ', ') into t from pg_tables where schemaname = 'public';
      if t is not null then execute 'truncate ' || t || ' cascade'; end if;
    end $$`);
  return { db: h.db, close: async () => {} };
}

export async function seedMerchant(db: Db, overrides: Partial<typeof merchants.$inferInsert> = {}) {
  const [m] = await db
    .insert(merchants)
    .values({
      id: newId('mer'),
      name: 'Acme OTT',
      webhookUrl: 'https://merchant.example/hooks',
      webhookSecret: 'whsec_test',
      category: 'GENERAL',
      methodCosts: { NETBANKING: { percentBps: 0, flatPaise: rs(8) } },
      steering: DEFAULT_STEERING,
      ...overrides,
    })
    .returning();
  return m!;
}

export async function seedMandate(db: Db, merchantId: string, overrides: Partial<typeof mandates.$inferInsert> = {}) {
  const [m] = await db
    .insert(mandates)
    .values({
      id: newId('mdt'),
      merchantId,
      mandateRef: 'UMN-123@psp',
      customerVpa: 'customer@okbank',
      maxAmountPaise: rs(15000),
      eligiblePsps: ['pspA', 'pspB'],
      ...overrides,
    })
    .returning();
  return m!;
}
