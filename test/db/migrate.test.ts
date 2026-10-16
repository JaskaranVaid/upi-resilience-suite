import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { assertSchemaCurrent, schemaStatus } from '../../src/db/migrate.js';

const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string }> };
const expected = journal.entries.length;
const latest = journal.entries.at(-1)!.tag;

describe('schema status (migration-aware startup)', () => {
  it('is up to date after migrating', async () => {
    const { db, close } = await createDb();
    try {
      expect(await schemaStatus(db)).toEqual({ expected, applied: expected, latest, upToDate: true });
      await expect(assertSchemaCurrent(db)).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it('is behind when the newest migration has not been applied, and startup refuses with what to do', async () => {
    const { db, close } = await createDb();
    try {
      await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`);
      expect(await schemaStatus(db)).toEqual({ expected, applied: expected - 1, latest, upToDate: false });
      await expect(assertSchemaCurrent(db)).rejects.toThrow(`database schema is behind this release (${expected - 1} of ${expected} migrations applied; missing ${latest}): run the migrate task (ROLE=migrate) first`);
    } finally {
      await close();
    }
  });

  it('reports an empty database without failing (no migrations table yet)', async () => {
    const { db, close } = await createDb('pglite://memory', { migrate: false });
    try {
      expect(await schemaStatus(db)).toEqual({ expected, applied: 0, latest, upToDate: false });
    } finally {
      await close();
    }
  });

  it('accepts a database that is ahead of the code (a rollback onto an expanded schema)', async () => {
    const { db, close } = await createDb();
    try {
      await db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', 99999999999999)`);
      expect((await schemaStatus(db)).upToDate).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('migration settings', () => {
  const base = { ADMIN_TOKEN: 'x'.repeat(20), CUSTOMER_TOKEN_SECRET: 'y'.repeat(40) } as NodeJS.ProcessEnv;

  it('migrates on start in development and test, never by default in production (the deploy migrates once)', async () => {
    const { loadEnv } = await import('../../src/config/env.js');
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).MIGRATE_ON_START).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).MIGRATE_ON_START).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).MIGRATE_ON_START).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: 'production', MIGRATE_ON_START: 'true' }).MIGRATE_ON_START).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: 'development', MIGRATE_ON_START: 'false' }).MIGRATE_ON_START).toBe(false);
  });

  it('accepts a migrate role and a pool size', async () => {
    const { loadEnv } = await import('../../src/config/env.js');
    const env = loadEnv({ ...base, NODE_ENV: 'test', ROLE: 'migrate', DATABASE_POOL_MAX: '20' });
    expect(env.ROLE).toBe('migrate');
    expect(env.DATABASE_POOL_MAX).toBe(20);
  });
});
