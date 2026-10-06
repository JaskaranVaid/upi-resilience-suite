import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { toIst } from '../../src/rules/time.js';
import { isRestricted } from '../../src/rules/windows.js';
import { DEFAULT_WINDOWS } from '../../src/config/rules.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const H = 3600_000;
const DAY = 24 * H;

/** A provider like Cashfree's controlled flow: 25 h minimum notice, notice at most ~6 days ahead, non-portable mandates. */
const strictCaps = { minNoticeMs: 25 * H, maxNoticeLeadMs: 6 * DAY, portableMandates: false };

describe('Scheduler honours the provider notice window', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let strict: MockPsp;
  let merchantId: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    strict = new MockPsp('strict', { capabilities: strictCaps });
    ctx = buildContext({ db, adapters: [strict, new MockPsp('loose')], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep });
    merchantId = (await seedMerchant(db)).id;
  });

  const load = async (id: string) => (await ctx.db.select().from(debits).where(eq(debits.id, id)))[0]!;
  const create = async (psp: string, over: { dueDate?: string } = {}) => {
    const md = await seedMandate(ctx.db, merchantId, { eligiblePsps: [psp] });
    return (await ctx.scheduler.createDebit(merchantId, md.id, { amountPaise: rs(499), idempotencyKey: `k-${md.id}`, ...over })).debit;
  };

  it("uses the provider's longer minimum notice (25 h) instead of the rule's 24 h", async () => {
    // At 16:00 the 24.5 h point (16:30 next day) is inside the off-peak window but 25.5 h is not,
    // so the two rules pick different days — this fails if the provider minimum is ignored.
    clock.set(ist('2026-10-15T16:00:00'));
    const d = await create('strict');
    expect(d.scheduledAt.getTime() - clock.now().getTime()).toBeGreaterThanOrEqual(25 * H + 30 * 60_000);
    expect(strict.notices).toHaveLength(1);
    expect(strict.notices[0]!.executionDate).toBe(d.noticeDate);
  });

  it('keeps the 24 h rule for providers without a stricter minimum', async () => {
    clock.set(ist('2026-10-15T16:00:00'));
    const d = await create('loose');
    const gap = d.scheduledAt.getTime() - clock.now().getTime();
    expect(gap).toBeGreaterThanOrEqual(24 * H + 30 * 60_000);
    expect(gap).toBeLessThan(25 * H + 30 * 60_000 + 4 * H);
  });

  it('defers the notice for a far-off due date, sends it ~6 days before, then executes on the due date', async () => {
    const d = await create('strict', { dueDate: '2026-11-04' });
    expect(strict.notices).toHaveLength(0); // too far ahead for the provider to accept a notice
    expect(d).toMatchObject({ state: 'SCHEDULED', noticeDate: null, noticeSentAt: null });
    // Next action: send the notice, at an off-peak moment inside the provider's T+1..T+7 window.
    const daysAhead = (Date.parse('2026-11-04') - Date.parse(toIst(d.scheduledAt).date)) / DAY;
    expect(daysAhead).toBeGreaterThanOrEqual(1);
    expect(daysAhead).toBeLessThanOrEqual(6);
    expect(isRestricted(d.scheduledAt, DEFAULT_WINDOWS)).toBe(false);

    clock.set(d.scheduledAt);
    await ctx.worker.runOnce();
    const notified = await load(d.id);
    expect(strict.notices.map((n) => n.executionDate)).toEqual(['2026-11-04']);
    expect(notified).toMatchObject({ state: 'SCHEDULED', noticeDate: '2026-11-04', attempts: 0 });
    expect(toIst(notified.scheduledAt).date).toBe('2026-11-04');
    expect(strict.calls.filter((c) => c.op === 'execute')).toHaveLength(0);

    clock.set(notified.scheduledAt);
    await ctx.worker.runOnce();
    expect(await load(d.id)).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
  });

  it('still notifies immediately for providers without a lead limit (unchanged behaviour)', async () => {
    const md = await seedMandate(ctx.db, merchantId, { eligiblePsps: ['loose'] });
    const { debit } = await ctx.scheduler.createDebit(merchantId, md.id, { amountPaise: rs(499), idempotencyKey: 'far', dueDate: '2026-11-04' });
    expect(debit.noticeDate).toBe('2026-11-04');
    expect(debit.noticeSentAt).not.toBeNull();
  });

  it('keeps non-portable mandates on their own PSP and defaults to portable PSPs', async () => {
    const { buildApp } = await import('../../src/api/app.js');
    const app = buildApp(ctx);
    const m = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${'x'.repeat(20)}` }, payload: { name: 'M' } });
    const auth = { authorization: `Bearer ${m.json().apiKey}` };
    const mandate = (eligiblePsps?: string[]) =>
      app.inject({ method: 'POST', url: '/v1/mandates', headers: auth, payload: { mandateRef: 'sub_1', customerVpa: 'ab@okaxis', maxAmountPaise: 1000, ...(eligiblePsps ? { eligiblePsps } : {}) } });

    const mixed = await mandate(['strict', 'loose']);
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.message).toMatch(/strict mandates can only be executed through strict/);
    expect((await mandate(['strict'])).json().eligiblePsps).toEqual(['strict']);
    expect((await mandate()).json().eligiblePsps).toEqual(['loose']); // default excludes non-portable
  });

  it('stops retrying a notice the provider keeps refusing, and fails the debit after the retry window', async () => {
    const d = await create('strict', { dueDate: '2026-11-04' }); // deferred notice
    (strict as unknown as { opts: { failNotices: boolean } }).opts.failNotices = true;
    let row = await load(d.id);
    let tries = 0;
    while (row.state === 'SCHEDULED' && tries < 1000) {
      clock.set(row.scheduledAt);
      await ctx.worker.runOnce();
      row = await load(d.id);
      tries++;
    }
    expect(row).toMatchObject({ state: 'FAILED', lastErrorCode: 'NOTICE_FAILED', attempts: 0 });
    expect(strict.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
    // Retried every 15 minutes until 48 h after the due date — bounded, not forever.
    expect(clock.now().getTime() - ist('2026-11-04T00:00:00').getTime()).toBeGreaterThanOrEqual(48 * H);
    expect(clock.now().getTime() - ist('2026-11-04T00:00:00').getTime()).toBeLessThan(49 * H);
  }, 120_000); // simulates hundreds of 15-minute retry cycles

  it('shows a pending notice in the debit view', async () => {
    const { debitView } = await import('../../src/scheduler/service.js');
    const d = await create('strict', { dueDate: '2026-11-04' });
    expect(debitView(d)).toMatchObject({ noticePending: true, noticeDate: null, dueDate: '2026-11-04' });
  });
});
