import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import { DEFAULT_POLLING } from '../../src/config/polling.js';
import type { Db } from '../../src/db/client.js';
import { debits, merchantPaymentsView, payments, paymentTracking } from '../../src/db/schema.js';
import { PspRegistry } from '../../src/psp/registry.js';
import { merchantStatusSql, PaymentQueryService } from '../../src/query/payments.js';
import { MERCHANT_STATUS_LABELS } from '../../src/tracking/derive.js';
import { freshDb, ist, seedMandate, seedMerchant } from '../helpers/fixtures.js';

/**
 * The SQL status expression must agree with merchantStatus() for every combination the data
 * model allows — otherwise list filters and overview counts would disagree with row labels.
 */
describe('merchantStatusSql ≡ merchantStatus()', () => {
  const now = ist('2026-10-15T14:00:00');
  let db: Db;
  let merchantId: string;

  beforeAll(async () => {
    ({ db } = await freshDb());
    merchantId = (await seedMerchant(db)).id;
    const mandateId = (await seedMandate(db, merchantId)).id;

    const domains = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
    const debitsOpts = ['UNKNOWN', 'DEBITED', 'NOT_DEBITED'] as const;
    const captures = ['UNKNOWN', 'CAPTURED', 'NOT_CAPTURED'] as const;
    const reversals = ['NONE', 'INITIATED', 'COMPLETED'] as const;
    const verifs = ['NOT_REQUIRED', 'IN_PROGRESS', 'RESOLVED', 'NEEDS_MANUAL_INVESTIGATION'] as const;
    const ages = [10_000, 60_000];
    let n = 0;

    for (const state of domains) {
      for (const age of ages) {
        // Collect with no tracking row (pre-Phase 3).
        const created = new Date(now.getTime() - age);
        await db.insert(payments).values({ id: `pay_${n++}`, merchantId, amountPaise: 100, payerVpa: 'a@ok', idempotencyKey: `k${n}`, state, createdAt: created, updatedAt: created });
        for (const customerDebit of debitsOpts)
          for (const capture of captures)
            for (const reversalStatus of reversals)
              for (const verificationStatus of verifs) {
                const id = `pay_${n++}`;
                await db.insert(payments).values({ id, merchantId, amountPaise: 100, payerVpa: 'a@ok', idempotencyKey: `k${n}`, state, createdAt: created, updatedAt: created });
                await db.insert(paymentTracking).values({ id: `trk_${id}`, merchantId, subjectType: 'COLLECT', subjectId: id, customerDebit, capture, reversalStatus, verificationStatus });
              }
      }
    }
    // AutoPay states, incl. waiting for a slot.
    for (const state of ['SCHEDULED', 'EXECUTING', 'PENDING_CONFIRMATION', 'SUCCEEDED', 'FAILED'] as const) {
      for (const attempts of [0, 1]) {
        const id = `dbt_${n++}`;
        await db.insert(debits).values({
          id, merchantId, mandateId, amountPaise: 100, idempotencyKey: `d${n}`, state, requestedAt: now, requestedInPeak: false,
          scheduledAt: now, noticeDate: '2026-10-15', noticeSentAt: now, attempts, maxAttempts: 3,
          executingSince: new Date(now.getTime() - 60_000), createdAt: now, updatedAt: now,
        });
      }
    }
  }, 120_000);

  it('agrees on every row', async () => {
    const clock = new FakeClock(now);
    const q = new PaymentQueryService({ db, clock, cfg: DEFAULT_POLLING, psps: new PspRegistry([]) });
    const ts = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = await q.list(merchantId, {}, { ...(cursor ? { cursor } : {}), limit: 100 });
      for (const r of page.data) ts.set(r.id, r.merchantStatus);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const sqlRows = await db
      .select({ id: merchantPaymentsView.id, status: merchantStatusSql(now, DEFAULT_POLLING) })
      .from(merchantPaymentsView)
      .where(eq(merchantPaymentsView.merchantId, merchantId));
    expect(sqlRows.length).toBe(ts.size);
    const mismatches = sqlRows.filter((r) => ts.get(r.id) !== r.status).map((r) => `${r.id}: sql=${r.status} ts=${ts.get(r.id)}`);
    expect(mismatches).toEqual([]);
    // The fixture exercises every status at least once.
    expect(new Set(sqlRows.map((r) => r.status))).toEqual(new Set(Object.keys(MERCHANT_STATUS_LABELS)));
  });

  it('filters by status with the same result as labelling', async () => {
    const clock = new FakeClock(now);
    const q = new PaymentQueryService({ db, clock, cfg: DEFAULT_POLLING, psps: new PspRegistry([]) });
    const r = await q.list(merchantId, { status: 'DEBITED_NOT_CAPTURED' }, { limit: 100 });
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data.every((p) => p.merchantStatus === 'DEBITED_NOT_CAPTURED')).toBe(true);
  });
});
