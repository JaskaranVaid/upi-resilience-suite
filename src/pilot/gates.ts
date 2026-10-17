import { and, count, desc, eq, gte, inArray, isNull, ne, or } from 'drizzle-orm';
import { resolvePeriod } from '../analytics/period.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { debits, duplicateSuspects, pspConnections, rolloutChanges } from '../db/schema.js';
import type { RolloutGate } from './rollout.js';
import type { PilotScorecard } from './scorecard.js';

export interface GateOptions {
  /** Days in CANARY before FULL. */
  minCanaryDays: number;
  /** Canary debits with a final outcome before FULL. */
  minCanaryDebits: number;
}

export const DEFAULT_GATES: GateOptions = { minCanaryDays: 7, minCanaryDebits: 30 };

const DAY = 86_400_000;

/**
 * The pilot's pre-conditions for a forward move (the rollback is never gated):
 * - into or within CANARY: the merchant hears about what Merchantflo executes (webhook URL), can be
 *   executed for (an active production connection when live), and has no unreviewed double debit;
 * - to FULL: all that, from CANARY only, after `minCanaryDays` and `minCanaryDebits`, with every
 *   gated scorecard criterion passing over the current canary stretch.
 */
export function pilotGates(deps: { db: Db; clock: Clock; scorecard: PilotScorecard; opts?: Partial<GateOptions> }): RolloutGate {
  const opts = { ...DEFAULT_GATES, ...deps.opts };
  const { db, clock } = deps;

  return async (merchant, to) => {
    const problems: string[] = [];
    if (!merchant.webhookUrl) problems.push('no webhook URL: the merchant would not hear about the debits Merchantflo executes');
    if (merchant.mode === 'LIVE') {
      const [c] = await db
        .select({ n: count() })
        .from(pspConnections)
        .where(and(eq(pspConnections.merchantId, merchant.id), eq(pspConnections.status, 'ACTIVE'), eq(pspConnections.environment, 'production')));
      if ((c?.n ?? 0) === 0) problems.push('no active production PSP connection');
    }
    const [open] = await db.select({ n: count() }).from(duplicateSuspects).where(and(eq(duplicateSuspects.merchantId, merchant.id), eq(duplicateSuspects.status, 'OPEN')));
    if ((open?.n ?? 0) > 0) problems.push(`${open!.n} suspected double debit${open!.n === 1 ? '' : 's'} not reviewed`);
    if (to.stage !== 'FULL') return problems;

    if (merchant.rolloutStage !== 'CANARY') return [...problems, 'go through CANARY first'];
    // The current canary stretch began when the merchant last entered CANARY from another stage.
    const [entered] = await db
      .select({ at: rolloutChanges.createdAt })
      .from(rolloutChanges)
      .where(and(eq(rolloutChanges.merchantId, merchant.id), eq(rolloutChanges.toStage, 'CANARY'), ne(rolloutChanges.fromStage, 'CANARY')))
      .orderBy(desc(rolloutChanges.createdAt))
      .limit(1);
    const now = clock.now();
    const since = entered?.at ?? now;
    const days = Math.floor((now.getTime() - since.getTime()) / DAY);
    if (days < opts.minCanaryDays) problems.push(`${days} day${days === 1 ? '' : 's'} in CANARY; needs ${opts.minCanaryDays}`);
    const [final] = await db
      .select({ n: count() })
      .from(debits)
      .where(
        and(
          eq(debits.merchantId, merchant.id),
          eq(debits.rolloutStage, 'CANARY'),
          inArray(debits.state, ['SUCCEEDED', 'FAILED']),
          or(isNull(debits.lastErrorCode), ne(debits.lastErrorCode, 'EXECUTED_BY_MERCHANT')),
          gte(debits.requestedAt, since),
        ),
      );
    const finals = final?.n ?? 0;
    if (finals < opts.minCanaryDebits) problems.push(`${finals} canary debit${finals === 1 ? '' : 's'} with a final outcome; needs ${opts.minCanaryDebits}`);
    if (now > since) {
      const card = await deps.scorecard.evaluate(merchant.id, resolvePeriod({ from: since.toISOString(), to: now.toISOString() }, now));
      for (const c of card.criteria) if (c.gated && c.status !== 'PASS') problems.push(`${c.label}: ${c.status.toLowerCase().replace('_', ' ')}`);
    }
    return problems;
  };
}
