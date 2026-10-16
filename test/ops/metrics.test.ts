import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import type { Db } from '../../src/db/client.js';
import { debits, paymentAttempts, paymentTracking, reconRuns, webhookOutbox } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { collectOpsMetrics, emitOpsMetrics, OPS_METRIC_NAMES } from '../../src/ops/metrics.js';
import { jsonLogger } from '../../src/ops/log.js';
import { HealthTracker } from '../../src/routing/health.js';
import { freshDb, ist, seedMandate, seedMerchant } from '../helpers/fixtures.js';

// 14:00 IST: between the 10:00–13:00 and 17:00–21:30 AutoPay peak windows.
const NOW = ist('2026-10-15T14:00:00');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

describe('operational metrics', () => {
  let db: Db;
  let clock: FakeClock;
  let health: HealthTracker;
  let merchantId: string;
  let mandateId: string;

  const collect = () => collectOpsMetrics({ db, clock, health });

  async function debit(over: Partial<typeof debits.$inferInsert> = {}) {
    const id = newId('dbt');
    await db.insert(debits).values({
      id, merchantId, mandateId, amountPaise: 49900, idempotencyKey: id, state: 'SUCCEEDED', requestedAt: ago(60 * MIN), requestedInPeak: false,
      scheduledAt: ago(60 * MIN), noticeDate: '2026-10-15', maxAttempts: 3, updatedAt: NOW, ...over,
    });
    return id;
  }

  async function executeAttempt(debitId: string, createdAt: Date, over: Partial<typeof paymentAttempts.$inferInsert> = {}) {
    await db.insert(paymentAttempts).values({ id: newId('att'), merchantId, debitId, pspId: 'pspA', txnRef: `${debitId}-a1`, op: 'execute', outcome: 'SUCCESS', latencyMs: 300, createdAt, ...over });
  }

  beforeEach(async () => {
    ({ db } = await freshDb());
    clock = new FakeClock(NOW);
    health = new HealthTracker({ minSamples: 2, cooldownMs: 60 * MIN }, clock);
    merchantId = (await seedMerchant(db)).id;
    mandateId = (await seedMandate(db, merchantId)).id;
  });

  it('is all zeros on a quiet system, with a heartbeat', async () => {
    expect(await collect()).toEqual({
      restrictedWindowExecutions: 0, noticeFailures: 0, debitBacklog: 0, pollerBacklog: 0, pollerOldestOverdueSeconds: 0,
      webhookBacklog: 0, deadWebhooks24h: 0, reconFailures24h: 0, pspCircuitsOpen: 0, openCircuits: [], executionPausesActive: 0, duplicateDebitsOpen: 0, workerHeartbeat: 1,
    });
  });

  describe('restricted-window executions', () => {
    it('counts an execution inside a peak window even though the debit then succeeded', async () => {
      clock.set(ist('2026-10-15T10:10:00'));
      const id = await debit({ state: 'SUCCEEDED' });
      await executeAttempt(id, ist('2026-10-15T10:05:00'));
      expect((await collect()).restrictedWindowExecutions).toBe(1);
    });

    it('ignores executions outside the windows, status checks and attempts on one-off payments', async () => {
      const id = await debit();
      await executeAttempt(id, ago(5 * MIN)); // 13:55, off-peak
      clock.set(ist('2026-10-15T10:10:00'));
      await executeAttempt(id, ist('2026-10-15T10:05:00'), { op: 'status' });
      await db.insert(paymentAttempts).values({ id: newId('att'), merchantId, paymentId: 'pay_x', pspId: 'pspA', txnRef: 'p1', op: 'collect', outcome: 'SUCCESS', latencyMs: 5, createdAt: ist('2026-10-15T10:05:00') });
      expect((await collect()).restrictedWindowExecutions).toBe(0);
    });

    it('judges an execution by when it started, not when its slow response was recorded', async () => {
      // Sent at 09:59:58 (off-peak), answered 4 s later inside the window: compliant.
      clock.set(ist('2026-10-15T10:05:00'));
      const id = await debit();
      await executeAttempt(id, ist('2026-10-15T10:00:02'), { latencyMs: 4000 });
      expect((await collect()).restrictedWindowExecutions).toBe(0);
    });

    it('works out when each failover attempt of one routing call started', async () => {
      // One call, recorded together at 10:00:03: pspA timed out after 4 s (started 09:59:59), then
      // pspB was tried at 10:00:03 minus its own 1 ms — inside the window.
      clock.set(ist('2026-10-15T10:05:00'));
      const id = await debit();
      const at = ist('2026-10-15T10:00:03');
      await executeAttempt(id, at, { seq: 0, latencyMs: 4000, outcome: 'TECHNICAL_DECLINE' });
      await executeAttempt(id, at, { seq: 1, latencyMs: 1, pspId: 'pspB' });
      expect((await collect()).restrictedWindowExecutions).toBe(1);
    });

    it('only looks back 15 minutes', async () => {
      clock.set(ist('2026-10-15T10:30:00'));
      const id = await debit();
      await executeAttempt(id, ist('2026-10-15T10:14:00'));
      expect((await collect()).restrictedWindowExecutions).toBe(0);
    });
  });

  it('counts debits failing to send their pre-debit notice in the last hour', async () => {
    await debit({ state: 'SCHEDULED', lastErrorCode: 'NOTICE_FAILED', scheduledAt: new Date(NOW.getTime() + 15 * MIN), updatedAt: ago(10 * MIN) });
    await debit({ state: 'FAILED', lastErrorCode: 'NOTICE_FAILED', updatedAt: ago(30 * MIN) });
    await debit({ state: 'FAILED', lastErrorCode: 'NOTICE_FAILED', updatedAt: ago(2 * 60 * MIN) }); // older
    await debit({ state: 'FAILED', lastErrorCode: 'INSUFFICIENT_FUNDS', updatedAt: ago(1 * MIN) }); // a different failure
    expect((await collect()).noticeFailures).toBe(2);
  });

  it('counts debits overdue for execution and executions stuck in flight', async () => {
    await debit({ state: 'SCHEDULED', scheduledAt: ago(6 * MIN) }); // overdue
    await debit({ state: 'PENDING_CONFIRMATION', scheduledAt: ago(20 * MIN) }); // overdue recheck
    await debit({ state: 'SCHEDULED', scheduledAt: ago(2 * MIN) }); // within grace
    await debit({ state: 'EXECUTING', updatedAt: ago(11 * MIN) }); // stuck
    await debit({ state: 'EXECUTING', updatedAt: ago(1 * MIN) }); // in progress
    expect((await collect()).debitBacklog).toBe(3);
  });

  it('measures the status poller backlog and its oldest overdue check', async () => {
    const track = (nextCheckAt: Date, verificationStatus: 'IN_PROGRESS' | 'RESOLVED' = 'IN_PROGRESS') =>
      db.insert(paymentTracking).values({ id: newId('trk'), merchantId, subjectType: 'COLLECT', subjectId: newId('pay'), verificationStatus, nextCheckAt });
    await track(ago(6 * MIN));
    await track(ago(30 * MIN));
    await track(ago(1 * MIN)); // within grace
    await track(ago(60 * MIN), 'RESOLVED'); // finished
    const m = await collect();
    expect(m.pollerBacklog).toBe(2);
    expect(m.pollerOldestOverdueSeconds).toBe(30 * 60);
  });

  it('counts overdue and dead webhooks', async () => {
    const hook = (over: Partial<typeof webhookOutbox.$inferInsert>) =>
      db.insert(webhookOutbox).values({ id: newId('whk'), merchantId, event: 'debit.succeeded', payload: {}, nextAttemptAt: ago(10 * MIN), ...over });
    await hook({}); // overdue
    await hook({ nextAttemptAt: ago(1 * MIN) }); // within grace
    await hook({ deliveredAt: ago(9 * MIN) }); // delivered
    await hook({ deadAt: ago(60 * MIN) }); // dead today
    await hook({ deadAt: ago(25 * 60 * MIN) }); // dead yesterday
    const m = await collect();
    expect(m.webhookBacklog).toBe(1);
    expect(m.deadWebhooks24h).toBe(1);
  });

  it('counts settlement reconciliation runs that failed in the last day', async () => {
    const run = (status: 'DONE' | 'FAILED', finishedAt: Date, day: string) =>
      db.insert(reconRuns).values({ id: newId('rcn'), merchantId, pspId: 'pspA', day, status, startedAt: finishedAt, finishedAt });
    await run('FAILED', ago(60 * MIN), '2026-10-14');
    await run('FAILED', ago(26 * 60 * MIN), '2026-10-13');
    await run('DONE', ago(60 * MIN), '2026-10-12');
    expect((await collect()).reconFailures24h).toBe(1);
  });

  it('reports open PSP circuits by id', async () => {
    health.record('pspB', { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' });
    health.record('pspB', { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' });
    health.record('pspA', { kind: 'SUCCESS', pspTxnId: 't' });
    const m = await collect();
    expect(m.pspCircuitsOpen).toBe(1);
    expect(m.openCircuits).toEqual(['pspB']);
  });

  it('logs one ops.metrics line whose fields are the metric names the alarms filter on', async () => {
    const lines: string[] = [];
    await emitOpsMetrics({ db, clock, health }, jsonLogger((l) => lines.push(l)));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.msg).toBe('ops.metrics');
    for (const name of OPS_METRIC_NAMES) expect(typeof entry[name], name).toBe('number');
  });

  it('logs a failure to collect instead of throwing', async () => {
    const lines: string[] = [];
    const broken = { execute: () => Promise.reject(new Error('db down')), select: () => { throw new Error('db down'); } } as unknown as Db;
    await emitOpsMetrics({ db: broken, clock, health }, jsonLogger((l) => lines.push(l)));
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', msg: 'ops.metrics collection failed' });
  });

  it('is available to operators with the admin token only', async () => {
    const ctx = buildContext({ db, adapters: [], adminToken: 'test-admin-token-1234', clock });
    const app = buildApp(ctx);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/ops/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/ops/metrics', headers: { authorization: 'Bearer sk_test_nope' } })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/ops/metrics', headers: { authorization: 'Bearer test-admin-token-1234' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workerHeartbeat: 1, restrictedWindowExecutions: 0 });
  });
});

describe('operational metrics queries', () => {
  it('are backed by indexes, since every worker runs them every minute', async () => {
    const { db } = await freshDb();
    const { sql } = await import('drizzle-orm');
    const rows = ((await db.execute(sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`)) as unknown as { rows: Array<{ indexname: string; indexdef: string }> }).rows;
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.get('attempts_execute_time')).toMatch(/\(created_at\) WHERE \(op = 'execute'::text\)/);
    expect(defs.get('outbox_dead_at')).toMatch(/\(dead_at\) WHERE \(dead_at IS NOT NULL\)/);
    expect(defs.get('debits_error_time')).toMatch(/\(last_error_code, updated_at\)/);
  });
});
