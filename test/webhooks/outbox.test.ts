import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import type { DbHandle } from '../../src/db/client.js';
import { webhookOutbox } from '../../src/db/schema.js';
import { enqueueWebhook, WebhookDispatcher } from '../../src/webhooks/outbox.js';
import { sign, verify } from '../../src/webhooks/sign.js';
import { recordSavings, savingsSummary } from '../../src/ledger/savings.js';
import { seedMerchant, testDb } from '../helpers/fixtures.js';

describe('webhook signing', () => {
  it('signs timestamp.body with HMAC-SHA256 and verifies', () => {
    const sig = sign('whsec_test', 1760500000, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verify('whsec_test', 1760500000, '{"a":1}', sig)).toBe(true);
    expect(verify('whsec_test', 1760500000, '{"a":2}', sig)).toBe(false);
    expect(verify('other', 1760500000, '{"a":1}', sig)).toBe(false);
  });
});

describe('webhook outbox', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await testDb();
  });
  afterAll(async () => h.close());

  it('delivers signed webhooks and marks them delivered', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const m = await seedMerchant(h.db);
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200 };
    };
    await enqueueWebhook(h.db, { merchantId: m.id, event: 'debit.succeeded', payload: { debitId: 'dbt_1' }, now: clock.now() });
    const d = new WebhookDispatcher(h.db, clock, fetchImpl);
    expect(await d.runOnce()).toBe(1);
    expect(sent).toHaveLength(1);
    const { headers, body } = sent[0]!;
    expect(headers['x-resilience-event']).toBe('debit.succeeded');
    expect(verify('whsec_test', Number(headers['x-resilience-timestamp']), body, headers['x-resilience-signature']!)).toBe(true);
    expect(JSON.parse(body).data).toEqual({ debitId: 'dbt_1' });
    expect(await d.runOnce()).toBe(0);
  });

  it('backs off on failure and gives up after max attempts', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const m = await seedMerchant(h.db);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 500 };
    };
    const id = await enqueueWebhook(h.db, { merchantId: m.id, event: 'debit.failed', payload: {}, now: clock.now() });
    const d = new WebhookDispatcher(h.db, clock, fetchImpl, { maxAttempts: 3 });
    await d.runOnce();
    expect(calls).toBe(1);
    await d.runOnce(); // not due yet
    expect(calls).toBe(1);
    clock.advance(3600_000);
    await d.runOnce();
    clock.advance(3600_000);
    await d.runOnce();
    clock.advance(3600_000);
    await d.runOnce();
    expect(calls).toBe(3);
    const [row] = await h.db.select().from(webhookOutbox).where(eq(webhookOutbox.id, id));
    expect(row!.deadAt).not.toBeNull();
    expect(row!.lastError).toContain('500');
  });
});

describe('savings ledger', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await testDb();
  });
  afterAll(async () => h.close());

  it('aggregates by type and is idempotent per (type, refId)', async () => {
    const m = await seedMerchant(h.db);
    const now = new Date('2026-10-15T08:00:00Z');
    await recordSavings(h.db, { merchantId: m.id, type: 'PEAK_DEFERRAL_RESCUED', amountPaise: 49900, refId: 'dbt_1', now });
    await recordSavings(h.db, { merchantId: m.id, type: 'PEAK_DEFERRAL_RESCUED', amountPaise: 49900, refId: 'dbt_1', now });
    await recordSavings(h.db, { merchantId: m.id, type: 'TD_RECOVERED', amountPaise: 20000, refId: 'pay_1', now });
    await recordSavings(h.db, { merchantId: m.id, type: 'MDR_STEERING_ACCEPTED', amountPaise: 900, refId: 'quo_1', now });
    const s = await savingsSummary(h.db, m.id);
    expect(s.byType.PEAK_DEFERRAL_RESCUED).toEqual({ count: 1, amountPaise: 49900 });
    expect(s.revenueProtectedPaise).toBe(69900);
    expect(s.feesSavedPaise).toBe(900);
  });
});
