import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { duplicateSuspects, shadowDebits } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { freshDb, seedMerchant } from '../helpers/fixtures.js';

describe('pilot schema', () => {
  let db: Db;
  beforeEach(async () => {
    db = (await freshDb()).db;
  });

  it('puts every merchant in FULL rollout unless an operator says otherwise', async () => {
    const m = await seedMerchant(db);
    expect(m.rolloutStage).toBe('FULL');
    expect(m.canaryPercent).toBeNull();
  });

  it('holds one shadow debit per merchant and idempotency key', async () => {
    const m = await seedMerchant(db);
    const row = () => ({
      id: newId('shd'), merchantId: m.id, mandateRef: 'UMN-1', idempotencyKey: 'inv-1', amountPaise: 49_900,
      source: 'MIRRORED' as const, requestedAt: new Date(), requestedInPeak: false, plannedAt: new Date(), plannedNoticeDate: '2026-10-17',
    });
    await db.insert(shadowDebits).values(row());
    await expect(db.insert(shadowDebits).values(row())).rejects.toThrow();
  });

  it('records each suspected double debit pair once', async () => {
    const m = await seedMerchant(db);
    const row = () => ({
      id: newId('dup'), merchantId: m.id, mandateRef: 'UMN-1', amountPaise: 49_900, firstKind: 'DEBIT' as const, firstId: 'dbt_1',
      secondKind: 'SHADOW' as const, secondId: 'shd_1', firstAt: new Date(), secondAt: new Date(), sameOrder: false, detectedAt: new Date(),
    });
    const [first] = await db.insert(duplicateSuspects).values(row()).returning();
    expect(first!.status).toBe('OPEN');
    await expect(db.insert(duplicateSuspects).values(row())).rejects.toThrow();
  });
});
