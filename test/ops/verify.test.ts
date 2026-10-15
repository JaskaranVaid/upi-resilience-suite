import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { debits, payments, webhookOutbox } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { verifyDatabase, withHost } from '../../src/ops/verify.js';
import { freshDb, ist, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const T = ist('2026-10-15T14:00:00');

describe('database verification (restore drills)', () => {
  let db: Db;
  let merchantId: string;
  let mandateId: string;

  beforeEach(async () => {
    ({ db } = await freshDb());
    merchantId = (await seedMerchant(db)).id;
    mandateId = (await seedMandate(db, merchantId)).id;
  });

  const debit = (over: Partial<typeof debits.$inferInsert>) =>
    db.insert(debits).values({
      id: newId('dbt'), merchantId, mandateId, amountPaise: 100, idempotencyKey: newId('dbt'), state: 'SCHEDULED', requestedAt: T, requestedInPeak: false,
      scheduledAt: T, maxAttempts: 3, ...over,
    });

  it('passes a consistent, fully migrated database and counts its rows', async () => {
    await debit({ state: 'SUCCEEDED', completedAt: T, pspTxnId: 'cf_1' });
    const r = await verifyDatabase(db);
    expect(r.ok).toBe(true);
    expect(r.schema.upToDate).toBe(true);
    expect(r.counts).toMatchObject({ merchants: 1, mandates: 1, debits: 1, payments: 0 });
    expect(r.invariants.every((i) => i.violations === 0)).toBe(true);
  });

  it('reports a terminal debit without a completion time', async () => {
    await debit({ state: 'FAILED', completedAt: null });
    const r = await verifyDatabase(db);
    expect(r.ok).toBe(false);
    expect(r.invariants.find((i) => i.name === 'terminal debits have completed_at')).toMatchObject({ violations: 1 });
  });

  it('reports a succeeded payment or debit without the PSP transaction id', async () => {
    await debit({ state: 'SUCCEEDED', completedAt: T, pspTxnId: null });
    await db.insert(payments).values({ id: newId('pay'), merchantId, amountPaise: 100, idempotencyKey: 'p1', state: 'SUCCEEDED', pspTxnId: null });
    const r = await verifyDatabase(db);
    expect(r.invariants.find((i) => i.name === 'succeeded payments and debits carry the PSP transaction id')).toMatchObject({ violations: 2 });
  });

  it('reports a webhook that is both delivered and dead', async () => {
    await db.insert(webhookOutbox).values({ id: newId('whk'), merchantId, event: 'debit.succeeded', payload: {}, nextAttemptAt: T, deliveredAt: T, deadAt: T });
    const r = await verifyDatabase(db);
    expect(r.invariants.find((i) => i.name === 'a webhook is never both delivered and dead')).toMatchObject({ violations: 1 });
    expect(r.ok).toBe(false);
  });

  it('points a connection URL at the restored instance, keeping credentials and options', () => {
    expect(withHost('postgres://u:p%40ss@merchantflo-staging.abc.ap-south-1.rds.amazonaws.com:5432/merchantflo?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem', 'drill-1.abc.ap-south-1.rds.amazonaws.com')).toBe(
      'postgres://u:p%40ss@drill-1.abc.ap-south-1.rds.amazonaws.com:5432/merchantflo?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem',
    );
  });
});
