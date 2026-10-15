import { and, asc, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { merchants, pspConnections, type MerchantMode } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { SecretBox } from '../security/secrets.js';
import type { PspAdapter } from './types.js';

export type ConnectionRow = typeof pspConnections.$inferSelect;

/** Builds the adapter for one merchant connection from its row and decrypted credentials. */
export type ConnectionAdapterFactory = (row: ConnectionRow, credentials: Record<string, string> | null) => PspAdapter;

export interface ConnectionSource {
  db: Db;
  secrets: SecretBox;
  build: ConnectionAdapterFactory;
  clock: Clock;
  /** Rebuild a cached adapter at most this often if its row changed elsewhere (other processes). */
  refreshMs?: number;
  log?: (msg: string) => void;
}

/** Which connection environments a merchant in each mode may use. */
export const ENVIRONMENT_FOR_MODE: Record<MerchantMode, ConnectionRow['environment']> = { TEST: 'sandbox', LIVE: 'production' };

interface Cached {
  adapter: PspAdapter;
  updatedAt: number;
  checkedAt: number;
}

/**
 * Resolves PSP ids to adapters. Two kinds of PSP exist:
 *  - shared adapters configured on the process (mocks, a platform sandbox account) — usable by
 *    TEST merchants only;
 *  - merchant connections (ADR 0002) — the merchant's own PSP accounts, whose id is the PSP id
 *    everywhere (mandates, payments, attempts, tracking, health).
 * Adapters for connections are built from decrypted credentials and cached per process.
 */
export class PspRegistry {
  private readonly shared: Map<string, PspAdapter>;
  private readonly cache = new Map<string, Cached>();

  constructor(
    shared: PspAdapter[],
    private readonly connections?: ConnectionSource,
  ) {
    this.shared = new Map(shared.map((a) => [a.id, a]));
  }

  sharedIds(): string[] {
    return [...this.shared.keys()];
  }

  /** The adapter for a PSP id (shared or connection, active or not — history must stay readable). */
  async get(id: string): Promise<PspAdapter> {
    const shared = this.shared.get(id);
    if (shared) return shared;
    const src = this.connections;
    if (!src) throw new Error(`Unknown PSP ${id}`);
    const now = src.clock.now().getTime();
    const hit = this.cache.get(id);
    if (hit && now - hit.checkedAt < (src.refreshMs ?? 60_000)) return hit.adapter;
    const [row] = await src.db.select().from(pspConnections).where(eq(pspConnections.id, id));
    if (!row) throw new Error(`Unknown PSP ${id}`);
    if (hit && hit.updatedAt === row.updatedAt.getTime()) {
      hit.checkedAt = now;
      return hit.adapter;
    }
    return this.remember(row, now);
  }

  /**
   * The PSPs a merchant may route through, in priority order: its ACTIVE connections in the
   * environment matching its mode, then (TEST merchants only) the shared adapters.
   */
  async forMerchant(merchantId: string): Promise<PspAdapter[]> {
    const src = this.connections;
    if (!src) return [...this.shared.values()];
    const [m] = await src.db.select({ mode: merchants.mode }).from(merchants).where(eq(merchants.id, merchantId));
    if (!m) throw new AppError('NOT_FOUND', `Merchant ${merchantId} not found`);
    const rows = await src.db
      .select()
      .from(pspConnections)
      .where(
        and(
          eq(pspConnections.merchantId, merchantId),
          eq(pspConnections.status, 'ACTIVE'),
          eq(pspConnections.environment, ENVIRONMENT_FOR_MODE[m.mode]),
        ),
      )
      .orderBy(asc(pspConnections.priority), asc(pspConnections.createdAt));
    const now = src.clock.now().getTime();
    const own: PspAdapter[] = [];
    for (const row of rows) {
      const hit = this.cache.get(row.id);
      if (hit && hit.updatedAt === row.updatedAt.getTime()) {
        own.push(hit.adapter);
        continue;
      }
      try {
        own.push(this.remember(row, now));
      } catch (e) {
        // One unusable connection (e.g. sealed with a key no longer configured) must not take the
        // merchant's other connections down with it. Never log credentials: only the id and reason.
        (src.log ?? ((m) => console.error(m)))(`PSP connection ${row.id} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return m.mode === 'TEST' ? [...own, ...this.shared.values()] : own;
  }

  /**
   * The subset of `ids` this merchant may send *new* work to (executions, notices) right now —
   * its own ACTIVE connections for its mode, plus shared adapters for TEST merchants — in the
   * order given. Lookups of past transactions use get(), which also resolves disabled connections.
   */
  async routable(merchantId: string, ids: string[]): Promise<PspAdapter[]> {
    const allowed = new Map((await this.forMerchant(merchantId)).map((a) => [a.id, a]));
    return ids.flatMap((id) => {
      const a = allowed.get(id);
      return a ? [a] : [];
    });
  }

  async idsFor(merchantId: string): Promise<string[]> {
    return (await this.forMerchant(merchantId)).map((a) => a.id);
  }

  /** Like forMerchant, but a merchant with nothing to route through is an error the caller can act on. */
  async requireForMerchant(merchantId: string): Promise<PspAdapter[]> {
    const adapters = await this.forMerchant(merchantId);
    if (adapters.length === 0) {
      throw new AppError('NO_PSP_CONNECTED', 'No active payment provider is connected for this merchant — add one with POST /v1/psp-connections');
    }
    return adapters;
  }

  /** Drop a cached adapter after its connection changed (credentials, status). */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  private remember(row: ConnectionRow, now: number): PspAdapter {
    const src = this.connections!;
    const credentials = row.credentialsSealed ? src.secrets.open<Record<string, string>>(row.credentialsSealed) : null;
    const adapter = src.build(row, credentials);
    this.cache.set(row.id, { adapter, updatedAt: row.updatedAt.getTime(), checkedAt: now });
    return adapter;
  }
}
