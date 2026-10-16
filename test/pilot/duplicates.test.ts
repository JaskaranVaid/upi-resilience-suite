import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, duplicateSuspects, operatorAudit, shadowDebits } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { collectOpsMetrics } from '../../src/ops/metrics.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

describe('double-debit detector', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let merchantId: string;
  let mandate: { id: string; mandateRef: string };

  /** A debit Merchantflo executed successfully at `at`. */
  const live = async (at: string, amount = 499, over: Partial<typeof debits.$inferInsert> = {}) => {
    const id = newId('dbt');
    const t = ist(at);
    await ctx.db.insert(debits).values({
      id, merchantId, mandateId: mandate.id, amountPaise: rs(amount), idempotencyKey: id, state: 'SUCCEEDED', requestedAt: t, requestedInPeak: false,
      scheduledAt: t, noticeDate: at.slice(0, 10), maxAttempts: 3, attempts: 1, executingSince: t, completedAt: new Date(t.getTime() + 60_000), ...over,
    });
    return id;
  };
  /** An execution the merchant's own system reported. */
  const reported = async (at: string, amount = 499, outcome: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED', ref = mandate.mandateRef, orderId: string | null = null) => {
    const id = newId('shd');
    const t = ist(at);
    await ctx.db.insert(shadowDebits).values({
      id, merchantId, mandateRef: ref, idempotencyKey: id, amountPaise: rs(amount), source: 'REPORTED', requestedAt: t, requestedInPeak: false,
      plannedAt: t, plannedNoticeDate: at.slice(0, 10), executedAt: t, outcome, orderId,
    });
    return id;
  };

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-16T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep });
    merchantId = (await seedMerchant(db)).id;
    mandate = await seedMandate(db, merchantId, { mandateRef: 'UMN-1' });
  });

  it('pairs a Merchantflo execution with a reported success on the same mandate and amount within 24 hours, once', async () => {
    const ours = await live('2026-10-15T08:00:00');
    const theirs = await reported('2026-10-15T19:00:00');
    expect(await ctx.duplicates.scan()).toBe(1);
    expect(await ctx.duplicates.scan()).toBe(0);
    const [s] = await ctx.db.select().from(duplicateSuspects);
    expect(s).toMatchObject({ merchantId, mandateRef: 'UMN-1', amountPaise: rs(499), firstKind: 'DEBIT', firstId: ours, secondKind: 'SHADOW', secondId: theirs, sameOrder: false, status: 'OPEN' });
  });

  it('pairs two Merchantflo executions too, and flags a shared order id', async () => {
    await live('2026-10-15T08:00:00', 499, { orderId: 'INV-7' });
    await live('2026-10-15T15:00:00', 499, { orderId: 'INV-7' });
    expect(await ctx.duplicates.scan()).toBe(1);
    expect((await ctx.db.select().from(duplicateSuspects))[0]!.sameOrder).toBe(true);
  });

  it('ignores different amounts, executions a day apart, failures, other mandates, and legacy-only pairs', async () => {
    await live('2026-10-10T08:00:00');
    await reported('2026-10-10T09:00:00', 999); // different amount
    await reported('2026-10-11T09:00:00'); // 25 hours later
    await reported('2026-10-10T10:00:00', 499, 'FAILED');
    await reported('2026-10-10T11:00:00', 499, 'SUCCEEDED', 'UMN-OTHER');
    await reported('2026-10-13T08:00:00');
    await reported('2026-10-13T09:00:00'); // legacy + legacy: the merchant's own system, not ours
    expect(await ctx.duplicates.scan()).toBe(0);
  });

  it('looks back a week, and runs at most every 10 minutes from the worker', async () => {
    await live('2026-10-01T08:00:00');
    await reported('2026-10-01T09:00:00');
    expect(await ctx.duplicates.scan()).toBe(0);
    await live('2026-10-14T08:00:00');
    await reported('2026-10-14T09:00:00');
    expect(await ctx.duplicates.runDue()).toBe(1);
    await live('2026-10-16T08:00:00');
    await reported('2026-10-16T09:00:00');
    expect(await ctx.duplicates.runDue()).toBe(0);
    clock.advance(10 * 60_000);
    expect(await ctx.duplicates.runDue()).toBe(1);
  });

  it('operators confirm or dismiss a suspect, audited; the open count is an ops gauge', async () => {
    await live('2026-10-15T08:00:00');
    await reported('2026-10-15T09:00:00');
    await ctx.duplicates.scan();
    expect((await collectOpsMetrics({ db: ctx.db, clock, health: ctx.health })).duplicateDebitsOpen).toBe(1);
    const [s] = await ctx.duplicates.list({ status: 'OPEN', limit: 10 });
    await expect(ctx.duplicates.resolve(s!.id, { resolution: 'CONFIRMED', note: ' ' }, 'opr_1')).rejects.toThrow(/note/);
    const done = await ctx.duplicates.resolve(s!.id, { resolution: 'CONFIRMED', note: 'customer refunded by merchant, ticket 42' }, 'opr_1');
    expect(done).toMatchObject({ status: 'CONFIRMED', resolvedBy: 'opr_1', resolutionNote: 'customer refunded by merchant, ticket 42' });
    await expect(ctx.duplicates.resolve(s!.id, { resolution: 'DISMISSED', note: 'x' }, 'opr_2')).rejects.toThrow(/already/);
    expect((await collectOpsMetrics({ db: ctx.db, clock, health: ctx.health })).duplicateDebitsOpen).toBe(0);
    const audit = await ctx.db.select().from(operatorAudit).where(eq(operatorAudit.action, 'DUPLICATE_RESOLVED'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operatorId: 'opr_1', target: s!.id, details: { resolution: 'CONFIRMED', merchantId } });
  });
});
