import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { migratePostgres, migrationsFolder } from './migrate.js';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A Db or an open transaction on it — services accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export interface DbOptions {
  /**
   * Apply pending migrations first (default). Production api/worker processes pass false: the
   * deploy's migrate task applies them once, and startup only checks (see assertSchemaCurrent).
   */
  migrate?: boolean;
  /** Maximum connections in the Postgres pool (node-postgres default: 10). */
  poolMax?: number;
}

/**
 * Open the database (and, by default, apply migrations).
 *  - undefined / "pglite://memory" → in-process in-memory Postgres (dev, tests)
 *  - "pglite://<dir>"              → in-process Postgres persisted to <dir>
 *  - "postgres://..."              → real Postgres via node-postgres; TLS through the URL
 *                                    (e.g. ?sslmode=verify-full&sslrootcert=/path/ca.pem)
 */
export async function createDb(url?: string, opts: DbOptions = {}): Promise<DbHandle> {
  const migrateFirst = opts.migrate ?? true;
  if (!url || url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const dir = url?.slice('pglite://'.length);
    const client = dir && dir !== 'memory' ? new PGlite(dir) : new PGlite();
    const db = drizzle(client, { schema });
    // One process owns a PGlite database, so no lock is needed.
    if (migrateFirst) await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => client.close() };
  }

  if (migrateFirst) await migratePostgres(url);
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new Pool({ connectionString: url, ...(opts.poolMax ? { max: opts.poolMax } : {}) });
  const db = drizzle(pool, { schema });
  return { db: db as unknown as Db, close: () => pool.end() };
}
