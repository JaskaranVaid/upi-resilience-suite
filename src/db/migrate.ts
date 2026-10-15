import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Postgres advisory lock held while migrating, so two processes never apply migrations at once. */
export const MIGRATION_LOCK_KEY = 7_221_998_431;

type Rows<T> = { rows: T[] };

interface Journal {
  entries: Array<{ tag: string; when: number }>;
}

function journal(): Journal {
  return JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as Journal;
}

export interface SchemaStatus {
  /** Migrations this release ships. */
  expected: number;
  /** Migrations recorded as applied in the database. */
  applied: number;
  /** Tag of this release's newest migration. */
  latest: string;
  /**
   * The database has every migration this release needs. A database that is *ahead* (a rollback
   * to the previous image after an expand-only migration) is up to date too.
   */
  upToDate: boolean;
}

/** Compare this release's migrations with what the database has applied (drizzle's own bookkeeping). */
export async function schemaStatus(db: Db): Promise<SchemaStatus> {
  const { entries } = journal();
  const newest = entries.at(-1)!;
  const [table] = ((await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`)) as unknown as Rows<{ t: string | null }>).rows;
  let applied = 0;
  let lastAt = 0;
  if (table?.t) {
    const [row] = ((await db.execute(sql`select count(*)::int as n, coalesce(max(created_at), 0)::text as last from drizzle.__drizzle_migrations`)) as unknown as Rows<{ n: number; last: string }>).rows;
    applied = Number(row?.n ?? 0);
    lastAt = Number(row?.last ?? 0);
  }
  // Drizzle applies every migration newer than the last one recorded, so that is the test.
  return { expected: entries.length, applied, latest: newest.tag, upToDate: lastAt >= newest.when };
}

/** Refuse to run this release's code against a database that is missing its migrations. */
export async function assertSchemaCurrent(db: Db): Promise<void> {
  const s = await schemaStatus(db);
  if (!s.upToDate) {
    throw new Error(`database schema is behind this release (${s.applied} of ${s.expected} migrations applied; missing ${s.latest}): run the migrate task (ROLE=migrate) first`);
  }
}

/** Apply migrations to a Postgres server while holding the migration advisory lock. */
export async function migratePostgres(url: string): Promise<void> {
  const { Client } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  // A session-level lock lives on one connection, so use a dedicated client rather than the pool.
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    // Whoever waited on the lock finds the migrations already applied and does nothing.
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
