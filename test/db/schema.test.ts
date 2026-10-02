import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { debits, merchantPaymentsView, payments, paymentTracking } from '../../src/db/schema.js';
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

  it('unifies collects and AutoPay debits in the merchant payments view', async () => {
    const m = await seedMerchant(h.db);
    const md = await seedMandate(h.db, m.id);
    const now = new Date('2026-10-15T08:00:00Z');
    await h.db.insert(payments).values({
      id: 'pay_v1', merchantId: m.id, amountPaise: 2500, payerVpa: 'a@ok', idempotencyKey: 'v1', orderId: 'ORD-1',
      state: 'PENDING', pspId: 'pspA', createdAt: now, updatedAt: now,
    });
    await h.db.insert(debits).values({
      id: 'dbt_v1', merchantId: m.id, mandateId: md.id, amountPaise: 49900, idempotencyKey: 'v1', orderId: 'INV-1',
      state: 'SCHEDULED', requestedAt: now, requestedInPeak: false, scheduledAt: now,
      noticeDate: '2026-10-16', noticeSentAt: now, maxAttempts: 3, createdAt: now, updatedAt: now,
    });
    await h.db.insert(paymentTracking).values({
      id: 'trk_v1', merchantId: m.id, subjectType: 'COLLECT', subjectId: 'pay_v1', pspId: 'pspA',
      upiRrn: '612345678901', customerDebit: 'DEBITED', verificationStatus: 'IN_PROGRESS',
    });

    const rows = await h.db.select().from(merchantPaymentsView).where(eq(merchantPaymentsView.merchantId, m.id)).orderBy(merchantPaymentsView.subjectType);
    expect(rows.map((r) => [r.subjectType, r.id, r.orderId, r.domainState, r.awaitingExecution, r.upiRrn, r.customerDebit])).toEqual([
      ['AUTOPAY', 'dbt_v1', 'INV-1', 'PENDING', true, null, null],
      ['COLLECT', 'pay_v1', 'ORD-1', 'PENDING', false, '612345678901', 'DEBITED'],
    ]);
  });

  it('allows one tracking row per payment', async () => {
    const m = await seedMerchant(h.db);
    const row = { merchantId: m.id, subjectType: 'COLLECT' as const, subjectId: 'pay_x', verificationStatus: 'NOT_REQUIRED' as const };
    await h.db.insert(paymentTracking).values({ id: 'trk_a', ...row });
    await expect(h.db.insert(paymentTracking).values({ id: 'trk_b', ...row })).rejects.toThrow();
  });

  it('supports FOR UPDATE SKIP LOCKED', async () => {
    const r = await h.db.execute(sql`select id from debits for update skip locked`);
    expect(r).toBeDefined();
  });
});
