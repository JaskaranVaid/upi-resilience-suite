import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { debits } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { seedMandate, seedMerchant, testDb } from '../helpers/fixtures.js';
import type { DbHandle } from '../../src/db/client.js';

describe('database', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await testDb();
  });
  afterAll(async () => h.close());

  it('migrates and round-trips bigint money as numbers', async () => {
    const m = await seedMerchant(h.db);
    const md = await seedMandate(h.db, m.id, { maxAmountPaise: 9_000_000_000_00 });
    expect(md.maxAmountPaise).toBe(9_000_000_000_00);
    expect(typeof md.maxAmountPaise).toBe('number');
  });

  it('enforces debit idempotency per merchant', async () => {
    const m = await seedMerchant(h.db);
    const md = await seedMandate(h.db, m.id);
    const row = () => ({
      id: newId('dbt'), merchantId: m.id, mandateId: md.id, amountPaise: 100, idempotencyKey: 'k1',
      state: 'SCHEDULED' as const, requestedAt: new Date(), requestedInPeak: false, scheduledAt: new Date(),
      noticeDate: '2026-10-16', noticeSentAt: new Date(), maxAttempts: 3,
    });
    await h.db.insert(debits).values(row());
    await expect(h.db.insert(debits).values(row())).rejects.toThrow();
  });

  it('supports FOR UPDATE SKIP LOCKED', async () => {
    const r = await h.db.execute(sql`select id from debits for update skip locked`);
    expect(r).toBeDefined();
  });
});
