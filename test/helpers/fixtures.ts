import { createHash } from 'node:crypto';
import { createDb, type Db } from '../../src/db/client.js';
import { mandates, merchants } from '../../src/db/schema.js';
import { DEFAULT_STEERING } from '../../src/rules/steering.js';
import { newId } from '../../src/ids.js';

export const ist = (s: string) => new Date(`${s}+05:30`);
export const rs = (n: number) => Math.round(n * 100);

export async function testDb() {
  return createDb();
}

export async function seedMerchant(db: Db, overrides: Partial<typeof merchants.$inferInsert> = {}) {
  const [m] = await db
    .insert(merchants)
    .values({
      id: newId('mer'),
      name: 'Acme OTT',
      apiKeyHash: createHash('sha256').update(newId('mer')).digest('hex'),
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
