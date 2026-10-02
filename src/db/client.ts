import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A Db or an open transaction on it — services accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Open the database and apply migrations.
 *  - undefined / "pglite://memory" → in-process in-memory Postgres (dev, tests)
 *  - "pglite://<dir>"              → in-process Postgres persisted to <dir>
 *  - "postgres://..."              → real Postgres via node-postgres
 */
export async function createDb(url?: string): Promise<DbHandle> {
  if (!url || url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const dir = url?.slice('pglite://'.length);
    const client = dir && dir !== 'memory' ? new PGlite(dir) : new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => client.close() };
  }

  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pool.end() };
}
