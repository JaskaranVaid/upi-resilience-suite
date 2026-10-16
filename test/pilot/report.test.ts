import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/analytics/period.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, paymentAttempts, shadowDebits } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { ShadowReportService } from '../../src/pilot/report.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const OCT = resolvePeriod({ month: '2026-10' }, ist('2026-10-20T12:00:00'));

describe('shadow report: what you would have saved', () => {
  let ctx: AppContext;
  let merchantId: string;
  let report: ShadowReportService;

  const exec = (key: string, amount: number, at: string, outcome: 'SUCCEEDED' | 'FAILED', failureKind?: 'TECHNICAL' | 'BUSINESS' | 'UNKNOWN') => ({
    idempotencyKey: key, mandateRef: `UMN-${key}`, amountPaise: rs(amount), executedAt: `${at}+05:30`, outcome, ...(failureKind ? { failureKind } : {}),
  });

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-20T12:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep });
    merchantId = (await seedMerchant(db)).id;
    report = new ShadowReportService({ db, opts: { minRecoverySample: 2 } });
    const r = await ctx.executionReports.report(merchantId, [
      exec('ok', 499, '2026-10-05T15:00:00', 'SUCCEEDED'),
      exec('risk', 299, '2026-10-05T18:30:00', 'SUCCEEDED'),
      exec('rescue', 1000, '2026-10-06T18:30:00', 'FAILED', 'TECHNICAL'),
      exec('retry', 500, '2026-10-07T15:00:00', 'FAILED', 'TECHNICAL'),
      exec('funds', 700, '2026-10-07T15:00:00', 'FAILED', 'BUSINESS'),
      exec('unknown', 800, '2026-10-08T18:30:00', 'FAILED'),
      exec('afa', 20_000, '2026-10-08T15:00:00', 'SUCCEEDED'),
      exec('september', 900, '2026-09-30T18:30:00', 'FAILED', 'TECHNICAL'),
    ]);
    expect(r.summary.created).toBe(8);
  });

  it('classifies each execution once and keeps certain and potential value apart', async () => {
    const s = await report.summary(merchantId, OCT);
    const cls = Object.fromEntries(s.classes.map((c) => [c.key, [c.count, c.amountPaise]]));
    expect(cls).toEqual({
      PEAK_RESCUE: [1, rs(1000)],
      RETRY_RECOVERABLE: [1, rs(500)],
      PEAK_RISK: [1, rs(299)],
      WOULD_REFUSE: [1, rs(20_000)],
      BUSINESS_DECLINE: [1, rs(700)],
      UNCLASSIFIED_FAILURE: [1, rs(800)],
      NO_CHANGE: [1, rs(499)],
    });
    expect(s.observed).toMatchObject({ count: 7, succeeded: 3 });
    expect(s.observed.successRate).toBeCloseTo(3 / 7, 10);
    expect(s.certainPaise).toBe(rs(1000));
    expect(s.potentialPaise).toBe(rs(500));
    expect(s.projectedSuccessRate.atLeast).toBeCloseTo(4 / 7, 10);
    expect(s.projectedSuccessRate.atMost).toBeCloseTo(5 / 7, 10);
    // No live Merchantflo traffic yet: no estimate, only the upper bound.
    expect(s.estimate).toBeNull();
    expect(s.bySource).toEqual({ MIRRORED: 0, REPORTED: 7 });
    for (const c of s.classes) expect(c.methodNote.length).toBeGreaterThan(20);
  });

  it('estimates recoverable value with the recovery rate measured on the merchant\'s own live debits', async () => {
    const mandate = await seedMandate(ctx.db, merchantId);
    for (const [i, state] of (['SUCCEEDED', 'FAILED'] as const).entries()) {
      const id = newId('dbt');
      const at = ist(`2026-10-0${i + 2}T15:00:00`);
      await ctx.db.insert(debits).values({
        id, merchantId, mandateId: mandate.id, amountPaise: rs(100), idempotencyKey: `live-${i}`, state, requestedAt: at, requestedInPeak: false,
        scheduledAt: at, noticeDate: '2026-10-02', maxAttempts: 3, attempts: 1, completedAt: at, rolloutStage: 'CANARY',
      });
      await ctx.db.insert(paymentAttempts).values({ id: newId('att'), merchantId, debitId: id, pspId: 'pspA', txnRef: `${id}-a1-1`, op: 'execute', outcome: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE', latencyMs: 10, createdAt: at });
    }
    const s = await report.summary(merchantId, OCT);
    expect(s.estimate).toEqual({ recoveryRate: 0.5, sample: 2, amountPaise: rs(250) });
  });

  it('counts mirrored debits still waiting for an outcome, and never counts a misrouted report', async () => {
    const mandate = await seedMandate(ctx.db, merchantId, { mandateRef: 'UMN-M' });
    const mirrored = async (key: string) => (await ctx.shadow.createFromIntake(merchantId, mandate, { amountPaise: rs(100), idempotencyKey: key }, 'SHADOW')).shadow;
    await mirrored('mirror-1');
    const reported = await mirrored('mirror-2');
    await ctx.db.update(shadowDebits).set({ outcome: 'SUCCEEDED', executedAt: ist('2026-10-19T15:00:00') }).where(eq(shadowDebits.id, reported.id));
    // A report for a debit Merchantflo executes is not the merchant's own traffic.
    const misrouted = await mirrored('mirror-3');
    await ctx.db.update(shadowDebits).set({ outcome: 'SUCCEEDED', executedAt: ist('2026-10-19T15:00:00'), liveDebitId: 'dbt_x' }).where(eq(shadowDebits.id, misrouted.id));

    const s = await report.summary(merchantId, OCT);
    expect(s.awaitingOutcome).toBe(1);
    expect(s.outcomeCoverage).toBe(0.5);
    expect(s.observed.count).toBe(8);
    expect(s.bySource).toEqual({ MIRRORED: 1, REPORTED: 7 });
  });

  it('lists every classified execution in the CSV', async () => {
    const csv = await report.rowsCsv(merchantId, OCT);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('shadow_debit_id,source,mandate_ref,order_id,amount_inr,amount_paise,requested_at_ist,executed_at_ist,planned_at_ist,outcome,failure_kind,failure_code,in_restricted_window,class,value');
    expect(lines).toHaveLength(8);
    expect(lines.find((l) => l.includes('UMN-rescue'))).toMatch(/,1000\.00,100000,.*,FAILED,TECHNICAL,,yes,PEAK_RESCUE,certain$/);
  });

});
