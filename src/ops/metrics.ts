import { and, count, eq, gte, inArray, isNotNull, isNull, lt, lte, min, or, type SQL } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { getRuleSet } from '../config/rules.js';
import type { Db } from '../db/client.js';
import { debits, duplicateSuspects, executionPauses, paymentAttempts, paymentTracking, reconRuns, webhookOutbox } from '../db/schema.js';
import type { HealthTracker } from '../routing/health.js';
import { isRestricted } from '../rules/windows.js';
import type { Logger } from './log.js';

const MIN = 60_000;

/** How far back each signal looks, and how late something may be before it counts as backlog. */
export const OPS_WINDOWS = {
  restrictedLookbackMs: 15 * MIN,
  noticeFailureLookbackMs: 60 * MIN,
  overdueGraceMs: 5 * MIN,
  executingStuckMs: 10 * MIN,
  dayMs: 24 * 60 * MIN,
};

/**
 * Gauges the alarms watch (infra/modules/monitoring). Each is computed from the database (only the
 * circuit states are this process's own view), so two worker replicas report the same values and
 * alarms take the Maximum, never the Sum.
 */
export interface OpsMetrics {
  /** AutoPay executions *started* inside an NPCI peak or blackout window in the last 15 minutes. Must stay 0. */
  restrictedWindowExecutions: number;
  /** Debits whose pre-debit notice the PSP refused, touched in the last hour (retrying or given up). */
  noticeFailures: number;
  /** Debits due more than 5 minutes ago and not yet picked up, plus executions stuck in flight for 10+ minutes. */
  debitBacklog: number;
  /** Status checks due more than 5 minutes ago. */
  pollerBacklog: number;
  pollerOldestOverdueSeconds: number;
  /** Merchant webhooks due more than 5 minutes ago and not delivered. */
  webhookBacklog: number;
  /** Webhooks that exhausted their retries (or were refused) in the last 24 hours. */
  deadWebhooks24h: number;
  /** Settlement reconciliation runs that failed in the last 24 hours. */
  reconFailures24h: number;
  /** PSP circuits this worker currently has open. */
  pspCircuitsOpen: number;
  openCircuits: string[];
  /** Kill-switch pauses in force (global, merchant or PSP). */
  executionPausesActive: number;
  /** Suspected double debits (pilot) no operator has reviewed yet. Must be 0. */
  duplicateDebitsOpen: number;
  /** Always 1: its absence means no worker is reporting. */
  workerHeartbeat: 1;
}

/** The numeric fields, one CloudWatch metric each (the metric filters in Terraform use these names). */
export const OPS_METRIC_NAMES = [
  'restrictedWindowExecutions',
  'noticeFailures',
  'debitBacklog',
  'pollerBacklog',
  'pollerOldestOverdueSeconds',
  'webhookBacklog',
  'deadWebhooks24h',
  'reconFailures24h',
  'pspCircuitsOpen',
  'executionPausesActive',
  'duplicateDebitsOpen',
  'workerHeartbeat',
] as const satisfies ReadonlyArray<keyof OpsMetrics>;

interface Deps {
  db: Db;
  clock: Clock;
  health: HealthTracker;
}

async function countWhere(db: Db, table: typeof debits | typeof paymentTracking | typeof webhookOutbox | typeof reconRuns | typeof executionPauses | typeof duplicateSuspects, where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(where);
  return row?.n ?? 0;
}

/**
 * Execute attempts are recorded when the routing call returns, all with the same created_at; each
 * one started its own latency, plus that of every later attempt in the call, earlier.
 */
async function restrictedWindowExecutions(db: Db, now: Date): Promise<number> {
  const rows = await db
    .select({ debitId: paymentAttempts.debitId, createdAt: paymentAttempts.createdAt, seq: paymentAttempts.seq, latencyMs: paymentAttempts.latencyMs })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.op, 'execute'),
        isNotNull(paymentAttempts.debitId),
        gte(paymentAttempts.createdAt, new Date(now.getTime() - OPS_WINDOWS.restrictedLookbackMs)),
        lte(paymentAttempts.createdAt, now),
      ),
    );
  const calls = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.debitId}@${r.createdAt.getTime()}`;
    calls.set(key, [...(calls.get(key) ?? []), r]);
  }
  let restricted = 0;
  for (const call of calls.values()) {
    call.sort((a, b) => b.seq - a.seq); // last attempt first
    let end = call[0]!.createdAt.getTime();
    for (const attempt of call) {
      const startedAt = new Date(end - attempt.latencyMs);
      if (isRestricted(startedAt, getRuleSet(startedAt).windows)) restricted++;
      end = startedAt.getTime();
    }
  }
  return restricted;
}

export async function collectOpsMetrics({ db, clock, health }: Deps): Promise<OpsMetrics> {
  const now = clock.now();
  const before = (ms: number) => new Date(now.getTime() - ms);
  const overdue = before(OPS_WINDOWS.overdueGraceMs);

  const pollerDue = and(eq(paymentTracking.verificationStatus, 'IN_PROGRESS'), lt(paymentTracking.nextCheckAt, overdue));
  const [oldest] = await db.select({ at: min(paymentTracking.nextCheckAt) }).from(paymentTracking).where(pollerDue);
  const openCircuits = health
    .snapshot()
    .filter((s) => s.state === 'OPEN')
    .map((s) => s.pspId)
    .sort();

  return {
    restrictedWindowExecutions: await restrictedWindowExecutions(db, now),
    noticeFailures: await countWhere(db, debits, and(eq(debits.lastErrorCode, 'NOTICE_FAILED'), gte(debits.updatedAt, before(OPS_WINDOWS.noticeFailureLookbackMs)))),
    debitBacklog: await countWhere(
      db,
      debits,
      or(
        and(inArray(debits.state, ['SCHEDULED', 'PENDING_CONFIRMATION']), lt(debits.scheduledAt, overdue)),
        and(eq(debits.state, 'EXECUTING'), lt(debits.updatedAt, before(OPS_WINDOWS.executingStuckMs))),
      ),
    ),
    pollerBacklog: await countWhere(db, paymentTracking, pollerDue),
    pollerOldestOverdueSeconds: oldest?.at ? Math.round((now.getTime() - oldest.at.getTime()) / 1000) : 0,
    webhookBacklog: await countWhere(db, webhookOutbox, and(isNull(webhookOutbox.deliveredAt), isNull(webhookOutbox.deadAt), lt(webhookOutbox.nextAttemptAt, overdue))),
    deadWebhooks24h: await countWhere(db, webhookOutbox, gte(webhookOutbox.deadAt, before(OPS_WINDOWS.dayMs))),
    reconFailures24h: await countWhere(db, reconRuns, and(eq(reconRuns.status, 'FAILED'), gte(reconRuns.finishedAt, before(OPS_WINDOWS.dayMs)))),
    pspCircuitsOpen: openCircuits.length,
    openCircuits,
    executionPausesActive: await countWhere(db, executionPauses, isNull(executionPauses.liftedAt)),
    duplicateDebitsOpen: await countWhere(db, duplicateSuspects, eq(duplicateSuspects.status, 'OPEN')),
    workerHeartbeat: 1,
  };
}

/** One `ops.metrics` log line; CloudWatch metric filters turn its fields into metrics. Never throws. */
export async function emitOpsMetrics(deps: Deps, log: Logger): Promise<void> {
  try {
    log.info('ops.metrics', { ...(await collectOpsMetrics(deps)) });
  } catch (e) {
    log.error('ops.metrics collection failed', e);
  }
}
