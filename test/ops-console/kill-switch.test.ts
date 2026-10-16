import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, operatorAudit, paymentAttempts } from '../../src/db/schema.js';
import { collectOpsMetrics } from '../../src/ops/metrics.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';

describe('kill switch (execution pauses)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let pspA: MockPsp;
  let pspB: MockPsp;

  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

  async function merchant(name: string) {
    const res = await call('POST', '/v1/merchants', ADMIN, { name, webhookUrl: 'https://merchant.example/hooks' });
    return { id: res.json().merchant.id as string, key: res.json().apiKey as string };
  }

  async function scheduledDebit(key: string, ref: string) {
    const mandate = (await call('POST', '/v1/mandates', key, { mandateRef: ref, customerVpa: 'asha@okhdfc', maxAmountPaise: rs(1000) })).json();
    return (await call('POST', `/v1/mandates/${mandate.id}/debits`, key, { amountPaise: rs(499), idempotencyKey: `${ref}-1` })).json() as { id: string; scheduledAt: string; noticeDate: string };
  }

  const state = async (id: string) => (await ctx.db.select().from(debits).where(eq(debits.id, id)))[0]!;
  const executions = async (id: string) => (await ctx.db.select().from(paymentAttempts).where(eq(paymentAttempts.debitId, id))).filter((a) => a.op === 'execute');
  const pay = (key: string, idem: string) => call('POST', '/v1/payments', key, { amountPaise: rs(250), payerVpa: 'ravi@okicici', idempotencyKey: idem });

  beforeEach(async () => {
    const { db } = await freshDb();
    // 14:00 IST, off-peak: debits requested now are scheduled for later today.
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    pspA = new MockPsp('pspA');
    pspB = new MockPsp('pspB');
    ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
  });

  it('a global pause stops new executions and new payments, and lifting it resumes them', async () => {
    const m = await merchant('StreamCo');
    const debit = await scheduledDebit(m.key, 'UMN-1');
    const pause = await ctx.pauses.pause({ scope: 'GLOBAL', reason: 'PSP incident drill' }, 'opr_test');

    clock.set(debit.scheduledAt);
    await ctx.worker.runOnce();
    expect((await state(debit.id)).state).toBe('SCHEDULED');
    expect(await executions(debit.id)).toHaveLength(0);

    const refused = await pay(m.key, 'p-1');
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('EXECUTION_PAUSED');
    // Debit requests are still accepted: they wait for the pause to end.
    expect((await scheduledDebit(m.key, 'UMN-2')).id).toBeTruthy();

    await ctx.pauses.lift(pause.id, 'opr_test');
    await ctx.worker.runOnce();
    expect((await state(debit.id)).state).toBe('SUCCEEDED');
    expect((await pay(m.key, 'p-2')).statusCode).toBe(201);
  });

  it('keeps confirming debits already sent to a PSP while paused', async () => {
    const m = await merchant('StreamCo');
    const debit = await scheduledDebit(m.key, 'UMN-1');
    pspA.enqueue({ kind: 'PENDING', settleAs: { kind: 'SUCCESS', pspTxnId: 'A-1' } });
    clock.set(debit.scheduledAt);
    await ctx.worker.runOnce();
    expect((await state(debit.id)).state).toBe('PENDING_CONFIRMATION');

    await ctx.pauses.pause({ scope: 'GLOBAL', reason: 'drill' }, 'opr_test');
    clock.advance(10 * 60_000);
    await ctx.worker.runOnce();
    expect((await state(debit.id)).state).toBe('SUCCEEDED');
  });

  it('puts back, without executing, a debit whose execution was interrupted before reaching the PSP', async () => {
    const m = await merchant('StreamCo');
    const debit = await scheduledDebit(m.key, 'UMN-1');
    await ctx.pauses.pause({ scope: 'GLOBAL', reason: 'drill' }, 'opr_test');
    // A worker crashed after claiming it (EXECUTING, no PSP call recorded yet).
    clock.set(debit.scheduledAt);
    await ctx.db.update(debits).set({ state: 'EXECUTING', executingSince: clock.now(), updatedAt: clock.now() }).where(eq(debits.id, debit.id));
    clock.advance(6 * 60_000);
    await ctx.worker.runOnce();
    expect((await state(debit.id)).state).toBe('SCHEDULED');
    expect(await executions(debit.id)).toHaveLength(0);
  });

  it('pausing one merchant leaves every other merchant running', async () => {
    const a = await merchant('Paused Co');
    const b = await merchant('Running Co');
    const da = await scheduledDebit(a.key, 'UMN-A');
    const db = await scheduledDebit(b.key, 'UMN-B');
    await ctx.pauses.pause({ scope: 'MERCHANT', target: a.id, reason: 'merchant asked' }, 'opr_test');

    clock.set(new Date(Math.max(Date.parse(da.scheduledAt), Date.parse(db.scheduledAt))));
    await ctx.worker.runOnce();
    expect((await state(da.id)).state).toBe('SCHEDULED');
    expect((await state(db.id)).state).toBe('SUCCEEDED');
    expect((await pay(a.key, 'pa')).statusCode).toBe(503);
    expect((await pay(b.key, 'pb')).statusCode).toBe(201);
  });

  it('a paused PSP is skipped: payments and debits go to the next PSP', async () => {
    const m = await merchant('StreamCo');
    await ctx.pauses.pause({ scope: 'PSP', target: 'pspA', reason: 'pspA degraded' }, 'opr_test');
    const res = await pay(m.key, 'p-1');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ state: 'SUCCEEDED', pspId: 'pspB' });

    const debit = await scheduledDebit(m.key, 'UMN-1');
    clock.set(debit.scheduledAt);
    await ctx.worker.runOnce();
    expect((await state(debit.id)).lastPspId ?? (await executions(debit.id))[0]?.pspId).toBe('pspB');
  });

  it('after a long pause, a debit whose notified date has passed gets a fresh notice and a new date', async () => {
    const m = await merchant('StreamCo');
    const debit = await scheduledDebit(m.key, 'UMN-1');
    const pause = await ctx.pauses.pause({ scope: 'GLOBAL', reason: 'outage' }, 'opr_test');
    clock.set(ist('2026-10-18T14:00:00'));
    await ctx.worker.runOnce();
    await ctx.pauses.lift(pause.id, 'opr_test');
    await ctx.worker.runOnce();
    const moved = await state(debit.id);
    expect(moved.state).toBe('SCHEDULED');
    expect(moved.noticeDate).not.toBe(debit.noticeDate);
    clock.set(moved.scheduledAt);
    await ctx.worker.runOnce();
    expect((await state(debit.id)).state).toBe('SUCCEEDED');
  });

  it('validates pauses, refuses duplicates and double lifts, and audits who did what and why', async () => {
    const m = await merchant('StreamCo');
    await expect(ctx.pauses.pause({ scope: 'MERCHANT', target: 'mer_nope', reason: 'x' }, 'opr_1')).rejects.toThrow('No merchant mer_nope');
    await expect(ctx.pauses.pause({ scope: 'PSP', reason: 'x' }, 'opr_1')).rejects.toThrow('needs a target');
    await expect(ctx.pauses.pause({ scope: 'GLOBAL', reason: ' ' }, 'opr_1')).rejects.toThrow('reason');
    const p = await ctx.pauses.pause({ scope: 'MERCHANT', target: m.id, reason: 'fraud review' }, 'opr_1');
    await expect(ctx.pauses.pause({ scope: 'MERCHANT', target: m.id, reason: 'again' }, 'opr_2')).rejects.toThrow('already paused');
    await ctx.pauses.lift(p.id, 'opr_2');
    await expect(ctx.pauses.lift(p.id, 'opr_2')).rejects.toThrow('already lifted');
    const audit = await ctx.db.select().from(operatorAudit);
    expect(audit.map((a) => [a.action, a.operatorId, a.target])).toEqual([
      ['EXECUTION_PAUSED', 'opr_1', `MERCHANT:${m.id}`],
      ['EXECUTION_RESUMED', 'opr_2', `MERCHANT:${m.id}`],
    ]);
    expect(audit[0]!.details).toMatchObject({ reason: 'fraud review', pauseId: p.id });
  });

  it('pauses every connection of a provider with provider:<name>', async () => {
    const m = await merchant('StreamCo');
    const conn = (await call('POST', '/v1/psp-connections', m.key, { provider: 'mock', label: 'Mock one' })).json();
    expect(conn.id).toMatch(/^con_/);
    await ctx.pauses.pause({ scope: 'PSP', target: 'provider:mock', reason: 'provider outage' }, 'opr_test');
    expect([...(await ctx.pauses.pausedPsps())]).toEqual([conn.id]);
  });

  it('reports active pauses in the ops metrics', async () => {
    expect((await collectOpsMetrics({ db: ctx.db, clock, health: ctx.health })).executionPausesActive).toBe(0);
    const p = await ctx.pauses.pause({ scope: 'GLOBAL', reason: 'drill' }, 'opr_test');
    expect((await collectOpsMetrics({ db: ctx.db, clock, health: ctx.health })).executionPausesActive).toBe(1);
    await ctx.pauses.lift(p.id, 'opr_test');
    expect((await collectOpsMetrics({ db: ctx.db, clock, health: ctx.health })).executionPausesActive).toBe(0);
  });
});
