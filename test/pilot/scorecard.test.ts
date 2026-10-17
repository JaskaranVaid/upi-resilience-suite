import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/analytics/period.js';
import { pilotScorecardResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, duplicateSuspects, paymentAttempts, paymentTracking, savingsEvents, shadowDebits, webhookOutbox, type DebitState } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import type { CriterionKey } from '../../src/pilot/scorecard.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const OCT = resolvePeriod({ month: '2026-10' }, ist('2026-10-20T12:00:00'));
const MIN = 60_000;

describe('pilot scorecard', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let merchantId: string;
  let mandateId: string;

  const status = async () => {
    const s = await ctx.scorecard.evaluate(merchantId, OCT);
    return Object.fromEntries(s.criteria.map((c) => [c.key, c.status])) as Record<CriterionKey, string>;
  };
  const criterion = async (key: CriterionKey) => (await ctx.scorecard.evaluate(merchantId, OCT)).criteria.find((c) => c.key === key)!;

  const debit = async (over: { state?: DebitState; at?: string; rolloutStage?: 'CANARY' | 'FULL'; lastErrorCode?: string; amount?: number } = {}) => {
    const id = newId('dbt');
    const at = ist(over.at ?? '2026-10-05T15:00:00');
    await ctx.db.insert(debits).values({
      id, merchantId, mandateId, amountPaise: rs(over.amount ?? 499), idempotencyKey: id, state: over.state ?? 'SUCCEEDED', requestedAt: at, requestedInPeak: false,
      scheduledAt: at, noticeDate: '2026-10-05', maxAttempts: 3, attempts: 1, executingSince: at, completedAt: at, updatedAt: at, createdAt: at,
      rolloutStage: over.rolloutStage ?? 'CANARY', lastErrorCode: over.lastErrorCode ?? null,
    });
    return id;
  };
  const control = async (outcome: 'SUCCEEDED' | 'FAILED', over: Partial<typeof shadowDebits.$inferInsert> = {}) => {
    const at = ist('2026-10-05T15:00:00');
    await ctx.db.insert(shadowDebits).values({
      id: newId('shd'), merchantId, mandateRef: 'UMN-C', idempotencyKey: newId('shd'), amountPaise: rs(499), source: 'MIRRORED', rolloutStage: 'CANARY',
      requestedAt: at, requestedInPeak: false, plannedAt: at, plannedNoticeDate: '2026-10-06', executedAt: at, outcome, failureKind: outcome === 'FAILED' ? 'TECHNICAL' : null, ...over,
    });
  };
  const settle = (subjectId: string, settlementStatus: 'SETTLED' | 'MISMATCH' | 'UNSETTLED') =>
    ctx.db.insert(paymentTracking).values({
      id: newId('trk'), merchantId, subjectType: 'AUTOPAY', subjectId, verificationStatus: 'NOT_REQUIRED', capture: 'CAPTURED', customerDebit: 'DEBITED', settlementStatus,
      ...(settlementStatus === 'UNSETTLED' ? {} : { settledAt: ist('2026-10-07T10:00:00'), settledAmountPaise: rs(490) }),
    });
  const hooks = (n: number, delayMs: number | null, at = ist('2026-10-05T15:00:00'), dead = false) =>
    ctx.db.insert(webhookOutbox).values(
      Array.from({ length: n }, () => ({
        id: newId('whk'), merchantId, event: 'debit.succeeded', payload: {}, nextAttemptAt: at, createdAt: at, attempts: 1,
        deliveredAt: delayMs === null ? null : new Date(at.getTime() + delayMs), deadAt: dead ? new Date(at.getTime() + 3600_000) : null,
      })),
    );

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-20T12:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep });
    merchantId = (await seedMerchant(db)).id;
    mandateId = (await seedMandate(db, merchantId)).id;
  });

  it('a quiet merchant passes nothing it has no data for', async () => {
    const s = await ctx.scorecard.evaluate(merchantId, OCT);
    expect(Object.fromEntries(s.criteria.map((c) => [c.key, c.status]))).toEqual({
      doubleDebits: 'PASS', restrictedWindowExecutions: 'PASS', autopayUplift: 'NO_DATA', webhooksOnTime: 'NO_DATA', statementReconciles: 'NO_DATA',
    });
    expect(s.passed).toBe(false);
    for (const c of s.criteria) expect(c.methodNote.length).toBeGreaterThan(30);
  });

  it('fails on any unreviewed or confirmed double debit in the period, not on a dismissed one', async () => {
    const suspect = { merchantId, mandateRef: 'UMN-1', amountPaise: rs(499), firstKind: 'DEBIT' as const, firstId: 'dbt_a', secondKind: 'SHADOW' as const, secondId: 'shd_b', firstAt: ist('2026-10-05T08:00:00'), secondAt: ist('2026-10-05T09:00:00'), sameOrder: false, detectedAt: ist('2026-10-05T10:00:00') };
    await ctx.db.insert(duplicateSuspects).values({ id: newId('dup'), ...suspect, status: 'DISMISSED' });
    expect((await status()).doubleDebits).toBe('PASS');
    await ctx.db.insert(duplicateSuspects).values({ id: newId('dup'), ...suspect, secondId: 'shd_c', status: 'OPEN' });
    expect(await criterion('doubleDebits')).toMatchObject({ status: 'FAIL', details: { open: 1, confirmed: 0 } });
  });

  it("fails on an execution of the merchant's debits that started inside a restricted window", async () => {
    const id = await debit();
    await ctx.db.insert(paymentAttempts).values({ id: newId('att'), merchantId, debitId: id, pspId: 'pspA', txnRef: 't', op: 'execute', outcome: 'SUCCESS', latencyMs: 100, createdAt: ist('2026-10-05T18:00:00') });
    expect(await criterion('restrictedWindowExecutions')).toMatchObject({ status: 'FAIL', details: { count: 1 } });
  });

  it('needs 99.9% of webhooks delivered within 5 minutes; young pending ones are not judged yet', async () => {
    await hooks(999, 30_000);
    await hooks(1, 10 * MIN);
    await hooks(1, null, new Date(clock.now().getTime() - MIN)); // pending, 1 minute old: not judged
    expect(await criterion('webhooksOnTime')).toMatchObject({ status: 'PASS', details: { judged: 1000, onTime: 999 } });
    await hooks(1, null, ist('2026-10-05T15:00:00'), true); // given up
    expect(await criterion('webhooksOnTime')).toMatchObject({ status: 'FAIL', details: { judged: 1001, onTime: 999 } });
  });

  it('measures AutoPay uplift as canary against control, with a 95% interval', async () => {
    for (let i = 0; i < 50; i++) await debit({ state: i < 45 ? 'SUCCEEDED' : 'FAILED' });
    await debit({ state: 'FAILED', lastErrorCode: 'EXECUTED_BY_MERCHANT' }); // handed back: not ours to count
    await debit({ state: 'SUCCEEDED', rolloutStage: 'FULL' }); // not the canary arm
    for (let i = 0; i < 50; i++) await control(i < 35 ? 'SUCCEEDED' : 'FAILED');
    await control('FAILED', { wouldRefuse: 'AFA_REQUIRED' }); // live intake would have refused it
    await control('SUCCEEDED', { liveDebitId: 'dbt_x' }); // a misroute report
    const c = await criterion('autopayUplift');
    expect(c.status).toBe('PASS');
    expect(c.details).toMatchObject({ canary: { n: 50, succeeded: 45 }, control: { n: 50, succeeded: 35 } });
    expect(c.details.difference as number).toBeCloseTo(0.2, 10);
    expect(c.details.low as number).toBeGreaterThan(0);
    // The documented response schema (OpenAPI, SDK) matches what the API sends.
    pilotScorecardResponse.parse(JSON.parse(JSON.stringify(await ctx.scorecard.evaluate(merchantId, OCT))));
  });

  it('calls a small or negative difference what it is', async () => {
    for (let i = 0; i < 5; i++) await debit({ state: i < 4 ? 'SUCCEEDED' : 'FAILED' });
    for (let i = 0; i < 5; i++) await control(i < 3 ? 'SUCCEEDED' : 'FAILED');
    expect((await status()).autopayUplift).toBe('PENDING');
    for (let i = 0; i < 60; i++) await control('SUCCEEDED');
    for (let i = 0; i < 60; i++) await debit({ state: 'FAILED' });
    expect((await status()).autopayUplift).toBe('FAIL');
  });

  it('reconciles every captured payment and value event to settlement', async () => {
    const settled = await debit();
    await settle(settled, 'SETTLED');
    expect((await status()).statementReconciles).toBe('PASS');

    // Captured yesterday, not settled yet: still within the grace period.
    const fresh = await debit({ at: '2026-10-19T15:00:00' });
    await settle(fresh, 'UNSETTLED');
    expect(await criterion('statementReconciles')).toMatchObject({ status: 'PENDING', details: { awaiting: 1 } });

    const old = await debit({ at: '2026-10-08T15:00:00' });
    await settle(old, 'UNSETTLED');
    const mismatch = await debit();
    await settle(mismatch, 'MISMATCH');
    // Value booked on a quote paid outside Merchantflo: no payment to check it against.
    await ctx.db.insert(savingsEvents).values({ id: newId('sav'), merchantId, type: 'MDR_STEERING_ACCEPTED', amountPaise: rs(12), refId: 'quo_x', createdAt: ist('2026-10-06T10:00:00') });
    await ctx.db.insert(savingsEvents).values({ id: newId('sav'), merchantId, type: 'TD_RECOVERED', amountPaise: rs(499), refId: settled, createdAt: ist('2026-10-05T16:00:00') });
    expect(await criterion('statementReconciles')).toMatchObject({ status: 'FAIL', details: { payments: 4, reconciled: 1, awaiting: 1, overdue: 1, mismatched: 1, valueEvents: 2, unverifiable: 1 } });
  });

  it('passes when every gated criterion passes', async () => {
    const id = await debit();
    await settle(id, 'SETTLED');
    await hooks(10, 1000);
    const s = await ctx.scorecard.evaluate(merchantId, OCT);
    expect(s.passed).toBe(true);
    expect(s.criteria.find((c) => c.key === 'autopayUplift')!.gated).toBe(false);
  });
});
