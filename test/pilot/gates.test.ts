import { eq, isNull, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, duplicateSuspects, merchants, operatorAudit, paymentTracking, pspConnections, rolloutChanges, webhookOutbox } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import type { RolloutActor } from '../../src/pilot/rollout.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const OPERATOR = { operatorId: 'opr_op', role: 'OPERATOR' as const };
const OWNER = { operatorId: 'opr_owner', role: 'OWNER' as const };

describe('pilot gates', () => {
  let ctx: AppContext;
  let clock: FakeClock;
  let merchantId: string;
  let mandateId: string;

  const change = (to: { stage: 'SHADOW' | 'CANARY' | 'FULL'; canaryPercent?: number; override?: boolean }, by: RolloutActor = OPERATOR) =>
    ctx.rollout.change(merchantId, { reason: 'pilot review', ...to }, by);
  const openSuspect = () =>
    ctx.db.insert(duplicateSuspects).values({
      id: newId('dup'), merchantId, mandateRef: 'UMN-1', amountPaise: rs(499), firstKind: 'DEBIT', firstId: newId('dbt'), secondKind: 'SHADOW', secondId: newId('shd'),
      firstAt: new Date(clock.now().getTime() - 120_000), secondAt: new Date(clock.now().getTime() - 60_000), sameOrder: false, detectedAt: clock.now(),
    });
  /** `n` canary debits Merchantflo executed, settled, each with an on-time webhook. */
  const canaryTraffic = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = newId('dbt');
      const at = new Date(clock.now().getTime() - (i + 1) * 3600_000);
      await ctx.db.insert(debits).values({
        id, merchantId, mandateId, amountPaise: rs(499), idempotencyKey: id, state: 'SUCCEEDED', requestedAt: at, requestedInPeak: false, scheduledAt: at,
        noticeDate: '2026-10-05', maxAttempts: 3, attempts: 1, executingSince: at, completedAt: at, createdAt: at, updatedAt: at, rolloutStage: 'CANARY',
      });
      await ctx.db.insert(paymentTracking).values({ id: newId('trk'), merchantId, subjectType: 'AUTOPAY', subjectId: id, verificationStatus: 'NOT_REQUIRED', capture: 'CAPTURED', settlementStatus: 'SETTLED', settledAmountPaise: rs(490) });
      await ctx.db.insert(webhookOutbox).values({ id: newId('whk'), merchantId, event: 'debit.succeeded', payload: {}, nextAttemptAt: at, createdAt: at, deliveredAt: new Date(at.getTime() + 2000), attempts: 1 });
    }
  };

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-01T12:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: 'x'.repeat(20), clock, sleep: clock.sleep });
    merchantId = (await seedMerchant(db)).id;
    mandateId = (await seedMandate(db, merchantId)).id;
    await change({ stage: 'SHADOW' });
  });

  it('lets a merchant into CANARY only with a webhook URL, a live PSP connection when live, and no unreviewed suspects', async () => {
    await ctx.db.update(merchants).set({ webhookUrl: null, mode: 'LIVE' }).where(eq(merchants.id, merchantId));
    await openSuspect();
    const refused = change({ stage: 'CANARY', canaryPercent: 5 });
    await expect(refused).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(refused).rejects.toThrow(/webhook URL.*production PSP connection.*1 suspected double debit/);

    await ctx.db.update(merchants).set({ webhookUrl: 'https://merchant.example/hooks' }).where(eq(merchants.id, merchantId));
    await ctx.db.insert(pspConnections).values({ id: newId('con'), merchantId, provider: 'mock', label: 'Live', environment: 'production' });
    await ctx.db.update(duplicateSuspects).set({ status: 'DISMISSED' });
    expect(await change({ stage: 'CANARY', canaryPercent: 5 })).toMatchObject({ rolloutStage: 'CANARY', canaryPercent: 5 });
    // Growing the canary is a forward move too.
    await openSuspect();
    await expect(change({ stage: 'CANARY', canaryPercent: 10 })).rejects.toThrow(/suspected double debit/);
  });

  it('always allows a rollback', async () => {
    await change({ stage: 'CANARY', canaryPercent: 10 });
    await openSuspect();
    await ctx.db.update(merchants).set({ webhookUrl: null }).where(eq(merchants.id, merchantId));
    expect(await change({ stage: 'CANARY', canaryPercent: 5 })).toMatchObject({ canaryPercent: 5 });
    expect(await change({ stage: 'SHADOW' })).toMatchObject({ rolloutStage: 'SHADOW' });
  });

  it('moves to FULL only after a week and 30 canary debits that pass every gated criterion', async () => {
    await expect(change({ stage: 'FULL' })).rejects.toThrow(/through CANARY first/);
    await change({ stage: 'CANARY', canaryPercent: 10 });
    clock.advance(3 * 86_400_000);
    await canaryTraffic(10);
    const early = change({ stage: 'FULL' });
    await expect(early).rejects.toThrow(/3 days in CANARY; needs 7/);
    await expect(early).rejects.toThrow(/10 canary debits with a final outcome; needs 30/);

    clock.advance(5 * 86_400_000);
    await canaryTraffic(25);
    // The dispatcher delivered the stage-change webhooks.
    await ctx.db.update(webhookOutbox).set({ deliveredAt: sql`${webhookOutbox.createdAt} + interval '1 second'` }).where(isNull(webhookOutbox.deliveredAt));
    await openSuspect();
    await expect(change({ stage: 'FULL' })).rejects.toThrow(/1 suspected double debit not reviewed; Zero double debits: fail/);
    await ctx.db.update(duplicateSuspects).set({ status: 'DISMISSED' });
    expect(await change({ stage: 'FULL' })).toMatchObject({ rolloutStage: 'FULL', canaryPercent: null });
  });

  it('lets only an owner override a gate, and records what was overridden', async () => {
    await expect(change({ stage: 'FULL', override: true })).rejects.toThrow(/owner/i);
    expect(await change({ stage: 'FULL', override: true }, OWNER)).toMatchObject({ rolloutStage: 'FULL' });
    const [last] = (await ctx.db.select().from(rolloutChanges).where(eq(rolloutChanges.merchantId, merchantId))).filter((c) => c.toStage === 'FULL');
    expect(last).toMatchObject({ override: true, operatorId: 'opr_owner' });
    const audit = (await ctx.db.select().from(operatorAudit).where(eq(operatorAudit.action, 'ROLLOUT_CHANGED'))).map((a) => a.details as Record<string, unknown>);
    expect(audit.find((d) => d.to === 'FULL')).toMatchObject({ override: true, overridden: ['go through CANARY first'] });
  });

  it('does not record an override that no gate needed', async () => {
    expect(await change({ stage: 'CANARY', canaryPercent: 5, override: true }, OWNER)).toMatchObject({ rolloutStage: 'CANARY' });
    const history = await ctx.rollout.history(merchantId);
    expect(history.at(-1)).toMatchObject({ toStage: 'CANARY', override: false });
  });
});
