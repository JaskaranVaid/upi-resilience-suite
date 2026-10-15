import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, eq, isNull, lt, or } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db, DbOrTx } from '../db/client.js';
import { apiKeys, merchants, type MerchantMode } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';

export type Merchant = typeof merchants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Don't write last_used_at more often than this per key. */
const TOUCH_INTERVAL_MS = 60_000;

export function apiKeyView(k: ApiKey) {
  return { id: k.id, prefix: k.prefix, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt };
}

/**
 * Merchant API keys: `sk_test_…` for TEST merchants, `sk_live_…` for LIVE ones. Only a SHA-256
 * hash is stored; the key itself is shown once, at creation.
 */
export class ApiKeyService {
  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  async issue(db: DbOrTx, merchantId: string, mode: MerchantMode, label: string | null): Promise<{ key: string; row: ApiKey }> {
    const key = `${mode === 'LIVE' ? 'sk_live' : 'sk_test'}_${randomBytes(24).toString('base64url')}`;
    const [row] = await db
      .insert(apiKeys)
      .values({ id: newId('key'), merchantId, prefix: key.slice(0, 12), keyHash: hashApiKey(key), label, createdAt: this.deps.clock.now() })
      .returning();
    return { key, row: row! };
  }

  /** The merchant behind an active key, or null. */
  async authenticate(key: string): Promise<{ merchant: Merchant; keyId: string } | null> {
    const { db, clock } = this.deps;
    const [row] = await db
      .select({ merchant: merchants, keyId: apiKeys.id, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .innerJoin(merchants, eq(merchants.id, apiKeys.merchantId))
      .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    const now = clock.now();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(and(eq(apiKeys.id, row.keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, new Date(now.getTime() - TOUCH_INTERVAL_MS)))));
    }
    return { merchant: row.merchant, keyId: row.keyId };
  }

  async list(merchantId: string): Promise<ApiKey[]> {
    return this.deps.db.select().from(apiKeys).where(eq(apiKeys.merchantId, merchantId)).orderBy(asc(apiKeys.createdAt));
  }

  /** Revoke every active key and issue one new key (used when a merchant's mode changes). */
  async replaceAll(db: DbOrTx, merchantId: string, mode: MerchantMode): Promise<string> {
    await db.update(apiKeys).set({ revokedAt: this.deps.clock.now() }).where(and(eq(apiKeys.merchantId, merchantId), isNull(apiKeys.revokedAt)));
    return (await this.issue(db, merchantId, mode, `Issued on switch to ${mode}`)).key;
  }

  /** Revoke a key. A merchant must always keep at least one active key. */
  async revoke(merchantId: string, keyId: string): Promise<ApiKey> {
    const { db, clock } = this.deps;
    return db.transaction(async (tx) => {
      const [k] = await tx.select().from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.merchantId, merchantId))).for('update');
      if (!k) throw new AppError('NOT_FOUND', `API key ${keyId} not found`);
      if (k.revokedAt) return k;
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(apiKeys)
        .where(and(eq(apiKeys.merchantId, merchantId), isNull(apiKeys.revokedAt)));
      if (Number(n) <= 1) throw new AppError('CONFLICT', 'Create another API key before revoking the last active one');
      const [revoked] = await tx.update(apiKeys).set({ revokedAt: clock.now() }).where(eq(apiKeys.id, keyId)).returning();
      return revoked!;
    });
  }
}
