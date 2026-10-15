import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('API keys', () => {
  let app: FastifyInstance;
  const as = (key: string) => ({ authorization: `Bearer ${key}` });
  const onboard = async (payload: object) =>
    (await app.inject({ method: 'POST', url: '/v1/merchants', headers: as(ADMIN), payload })).json() as { apiKey: string; merchant: { id: string; mode: string } };

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    app = buildApp(buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep }));
  });

  it('issues sk_test_ keys to test merchants (the default) and sk_live_ keys to live ones', async () => {
    const test = await onboard({ name: 'Sandbox Co' });
    expect(test.merchant.mode).toBe('TEST');
    expect(test.apiKey).toMatch(/^sk_test_/);
    const live = await onboard({ name: 'Live Co', mode: 'LIVE' });
    expect(live.apiKey).toMatch(/^sk_live_/);
  });

  it('creates, lists and revokes keys; a revoked key stops working on the next request', async () => {
    const { apiKey } = await onboard({ name: 'M' });
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: as(apiKey), payload: { label: 'billing-service' } });
    expect(created.statusCode).toBe(201);
    const second = created.json();
    expect(second.key).toMatch(/^sk_test_/);
    expect(second.prefix).toBe(second.key.slice(0, 12));

    const list = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: as(second.key) })).json().data;
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/keyHash|sk_test_[A-Za-z0-9_-]{20}/); // never the key or its hash
    expect(list.every((k: { lastUsedAt: string | null }) => 'lastUsedAt' in k)).toBe(true);

    const first = list.find((k: { id: string }) => k.id !== second.id);
    const revoked = await app.inject({ method: 'POST', url: `/v1/api-keys/${first.id}/revoke`, headers: as(second.key) });
    expect(revoked.json().revokedAt).not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/merchants/me', headers: as(apiKey) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/merchants/me', headers: as(second.key) })).statusCode).toBe(200);
  });

  it('refuses to revoke the last active key', async () => {
    const { apiKey } = await onboard({ name: 'M' });
    const [only] = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: as(apiKey) })).json().data;
    const res = await app.inject({ method: 'POST', url: `/v1/api-keys/${only.id}/revoke`, headers: as(apiKey) });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/v1/merchants/me', headers: as(apiKey) })).statusCode).toBe(200);
  });

  it("can't see or revoke another merchant's keys", async () => {
    const a = await onboard({ name: 'A' });
    const b = await onboard({ name: 'B' });
    const [bKey] = (await app.inject({ method: 'GET', url: '/v1/api-keys', headers: as(b.apiKey) })).json().data;
    expect((await app.inject({ method: 'POST', url: `/v1/api-keys/${bKey.id}/revoke`, headers: as(a.apiKey) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/api-keys', headers: as(a.apiKey) })).json().data).toHaveLength(1);
  });
});

describe('migration 0010 (keys move to api_keys)', () => {
  it('keeps an existing merchant key working', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    // Migrate a database to just before the move, as an existing deployment would be.
    const dir = mkdtempSync(join(tmpdir(), 'mf-mig-'));
    cpSync('drizzle', dir, { recursive: true });
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const full = structuredClone(journal);
    journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0010');
    writeFileSync(journalPath, JSON.stringify(journal));
    const client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: dir });
    const legacyKey = 'sk_live_legacy-key-from-before-phase-2';
    await db.execute(sql`insert into merchants (id, name, api_key_hash, webhook_secret, category, method_costs, steering)
      values ('mer_old', 'Old Co', ${createHash('sha256').update(legacyKey).digest('hex')}, 'whsec_x', 'GENERAL', '{}', '{}')`);
    writeFileSync(journalPath, JSON.stringify(full));
    await migrate(db, { migrationsFolder: dir });
    const rows = (await db.execute(sql`select merchant_id, key_hash, revoked_at from api_keys`)).rows;
    expect(rows).toEqual([{ merchant_id: 'mer_old', key_hash: createHash('sha256').update(legacyKey).digest('hex'), revoked_at: null }]);
    await client.close();
  });
});

describe('operator mode change (migrating a merchant to live)', () => {
  it('switches mode, replaces every key, and lets the merchant move its mandates to its own connection', async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep });
    const app = buildApp(ctx);
    const as = (key: string) => ({ authorization: `Bearer ${key}` });
    const onboard = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: as(ADMIN), payload: { name: 'Early Co' } })).json();
    const oldKey = onboard.apiKey as string;
    const merchantId = onboard.merchant.id as string;
    for (const ref of ['UMN-1', 'UMN-2']) {
      await app.inject({ method: 'POST', url: '/v1/mandates', headers: as(oldKey), payload: { mandateRef: ref, customerVpa: 'asha@okhdfc', maxAmountPaise: 50000 } });
    }

    expect((await app.inject({ method: 'PATCH', url: `/v1/admin/merchants/${merchantId}`, headers: as(oldKey), payload: { mode: 'LIVE' } })).statusCode).toBe(401);
    const switched = await app.inject({ method: 'PATCH', url: `/v1/admin/merchants/${merchantId}`, headers: as(ADMIN), payload: { mode: 'LIVE' } });
    expect(switched.json().merchant.mode).toBe('LIVE');
    const liveKey = switched.json().apiKey as string;
    expect(liveKey).toMatch(/^sk_live_/);
    expect((await app.inject({ method: 'GET', url: '/v1/merchants/me', headers: as(oldKey) })).statusCode).toBe(401);

    // Its mandates still name the shared mock, which a live merchant can't use…
    const mandate = (await app.inject({ method: 'POST', url: '/v1/mandates', headers: as(liveKey), payload: { mandateRef: 'UMN-3', customerVpa: 'asha@okhdfc', maxAmountPaise: 1 } })).json();
    expect(mandate.error.code).toBe('NO_PSP_CONNECTED');
    // …until it connects its own account and moves them over.
    const { pspConnections } = await import('../../src/db/schema.js');
    const { newId } = await import('../../src/ids.js');
    const [conn] = await db.insert(pspConnections).values({ id: newId('con'), merchantId, provider: 'mock', label: 'Own', environment: 'production' }).returning();
    const moved = await app.inject({ method: 'POST', url: '/v1/mandates/move-psp', headers: as(liveKey), payload: { from: 'pspA', to: conn!.id } });
    expect(moved.json()).toEqual({ moved: 2 });
    const { mandates } = await import('../../src/db/schema.js');
    expect((await db.select().from(mandates)).map((m) => m.eligiblePsps)).toEqual([[conn!.id], [conn!.id]]);
  });

  it('re-points one mandate, accepting only the merchant\'s own routable PSPs', async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const app = buildApp(buildContext({ db, adapters: [new MockPsp('pspA'), new MockPsp('pspB')], adminToken: ADMIN, clock, sleep: clock.sleep }));
    const key = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'M' } })).json().apiKey;
    const auth = { authorization: `Bearer ${key}` };
    const m = (await app.inject({ method: 'POST', url: '/v1/mandates', headers: auth, payload: { mandateRef: 'U', customerVpa: 'asha@okhdfc', maxAmountPaise: 500 } })).json();
    const ok = await app.inject({ method: 'PATCH', url: `/v1/mandates/${m.id}`, headers: auth, payload: { eligiblePsps: ['pspB'], maxAmountPaise: 900 } });
    expect(ok.json()).toMatchObject({ eligiblePsps: ['pspB'], maxAmountPaise: 900 });
    expect((await app.inject({ method: 'PATCH', url: `/v1/mandates/${m.id}`, headers: auth, payload: { eligiblePsps: ['con_someone_else'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/v1/mandates/${m.id}`, headers: auth, payload: { mandateRef: 'X' } })).statusCode).toBe(400);
  });
});
