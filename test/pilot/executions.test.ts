import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { shadowDebitResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { getRuleSet } from '../../src/config/rules.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { debits, shadowDebits, webhookOutbox } from '../../src/db/schema.js';
import { MockPsp } from '../../src/psp/mock.js';
import { isRestricted } from '../../src/rules/windows.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token-1234';
const OWNER = { operatorId: 'opr_1', role: 'OWNER' as const };

describe('reported executions (legacy outcomes and backtests)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let psp: MockPsp;
  let merchant: { id: string; key: string };

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${merchant.key}`, ...headers } });
  const mandate = async (ref: string) => (await call('POST', '/v1/mandates', { mandateRef: ref, customerVpa: 'asha@okhdfc', maxAmountPaise: rs(5000) })).json() as { id: string };
  const debit = async (mandateId: string, key: string, amountPaise = rs(499)) => (await call('POST', `/v1/mandates/${mandateId}/debits`, { amountPaise, idempotencyKey: key })).json();
  const report = (executions: unknown[]) => call('POST', '/v1/pilot/executions', { executions });
  const stage = (s: 'SHADOW' | 'FULL') => ctx.rollout.change(merchant.id, { stage: s, reason: 'test', override: true }, OWNER);
  const shadow = async (id: string) => shadowDebitResponse.parse((await call('GET', `/v1/shadow-debits/${id}`)).json());

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-16T14:00:00'));
    psp = new MockPsp('pspA');
    ctx = buildContext({ db, adapters: [psp], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    const r = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'StreamCo', webhookUrl: 'https://merchant.example/hooks' } })).json();
    merchant = { id: r.merchant.id, key: r.apiKey };
  });

  it("records a shadow debit's outcome, and a later report replaces it", async () => {
    await stage('SHADOW');
    const m = await mandate('UMN-1');
    const created = await debit(m.id, 'inv-1');
    clock.advance(26 * 3600_000);

    const first = await report([{ idempotencyKey: 'inv-1', executedAt: clock.now().toISOString(), outcome: 'FAILED', failureKind: 'TECHNICAL', failureCode: 'U68', attempts: 1 }]);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ summary: { recorded: 1 }, results: [{ index: 0, idempotencyKey: 'inv-1', status: 'RECORDED', shadowDebitId: created.id }] });
    expect((await shadow(created.id)).outcome).toMatchObject({ status: 'FAILED', failureKind: 'TECHNICAL', failureCode: 'U68', attempts: 1 });

    const retried = { idempotencyKey: 'inv-1', executedAt: new Date(clock.now().getTime() + 3600_000).toISOString(), outcome: 'SUCCEEDED', pspTxnId: 'cf_99', attempts: 2 };
    clock.advance(2 * 3600_000);
    expect((await report([retried])).json().results[0].status).toBe('UPDATED');
    expect((await shadow(created.id)).outcome).toMatchObject({ status: 'SUCCEEDED', failureKind: null, failureCode: null, pspTxnId: 'cf_99' });
    expect((await report([retried])).json().results[0].status).toBe('UNCHANGED');
  });

  it('imports history as reported shadow debits, planned under the rules of the day (backtest)', async () => {
    const known = await mandate('UMN-KNOWN');
    const res = await report([
      // Billing fired at 18:00 IST, in the evening peak; the legacy path ran it at once and it failed.
      { idempotencyKey: 'h-1', mandateRef: 'UMN-OLD', amountPaise: rs(299), requestedAt: '2026-09-10T18:00:00+05:30', executedAt: '2026-09-10T18:00:05+05:30', outcome: 'FAILED', failureKind: 'TECHNICAL' },
      { idempotencyKey: 'h-2', mandateRef: 'UMN-KNOWN', amountPaise: rs(299), executedAt: '2026-09-11T08:00:00+05:30', outcome: 'SUCCEEDED' },
    ]);
    expect(res.json().summary).toMatchObject({ created: 2 });
    const [a, b] = res.json().results.map((r: { shadowDebitId: string }) => r.shadowDebitId);
    const old = await shadow(a);
    expect(old).toMatchObject({ source: 'REPORTED', rolloutStage: null, mandateId: null, mandateRef: 'UMN-OLD', requestedInPeak: true, outcome: { status: 'FAILED' } });
    const plannedAt = new Date(old.plannedAt);
    expect(plannedAt.getTime() - ist('2026-09-10T18:00:00').getTime()).toBeGreaterThanOrEqual(24 * 3600_000);
    expect(isRestricted(plannedAt, getRuleSet(plannedAt).windows)).toBe(false);
    expect((await shadow(b)).mandateId).toBe(known.id);
  });

  it('judges each item on its own: invalid and conflicting items are reported, the rest recorded', async () => {
    await stage('SHADOW');
    const m = await mandate('UMN-1');
    await debit(m.id, 'inv-1');
    const now = clock.now().toISOString();
    const res = await report([
      { idempotencyKey: 'inv-1', executedAt: now, outcome: 'SUCCEEDED' },
      { idempotencyKey: 'inv-1', mandateRef: 'UMN-1', amountPaise: rs(1), executedAt: now, outcome: 'SUCCEEDED' },
      { idempotencyKey: 'x-1', executedAt: now, outcome: 'SUCCEEDED' },
      { idempotencyKey: 'x-2', mandateRef: 'UMN-9', amountPaise: rs(10), executedAt: new Date(clock.now().getTime() + 3600_000).toISOString(), outcome: 'SUCCEEDED' },
      { idempotencyKey: 'x-3', mandateRef: 'UMN-9', amountPaise: rs(10), outcome: 'FAILED' },
      { idempotencyKey: 'x-4', mandateRef: 'UMN-9', amountPaise: rs(10), executedAt: now, outcome: 'SUCCEEDED', failureKind: 'TECHNICAL' },
      { idempotencyKey: 'x-5', mandateRef: 'UMN-9', amountPaise: rs(10), requestedAt: new Date(clock.now().getTime() + 60_000).toISOString(), executedAt: now, outcome: 'SUCCEEDED' },
    ]);
    const statuses = res.json().results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(['RECORDED', 'CONFLICT', 'INVALID', 'INVALID', 'INVALID', 'INVALID', 'INVALID']);
    const errors = res.json().results.map((r: { error?: string }) => r.error ?? '');
    expect(errors[2]).toMatch(/mandateRef and amountPaise/);
    expect(errors[3]).toMatch(/future/);
    expect(errors[4]).toMatch(/executedAt/);
    expect(errors[5]).toMatch(/failureKind/);
    expect(errors[6]).toMatch(/requestedAt/);
    expect((await call('POST', '/v1/pilot/executions', { executions: [] })).statusCode).toBe(400);
  });

  it('hands back a debit Merchantflo had only scheduled when the merchant reports executing it', async () => {
    const m = await mandate('UMN-1');
    const live = await debit(m.id, 'inv-1');
    const res = await report([{ idempotencyKey: 'inv-1', executedAt: clock.now().toISOString(), outcome: 'SUCCEEDED', pspTxnId: 'legacy-1' }]);
    expect(res.json()).toMatchObject({ summary: { misrouted: 1 }, results: [{ status: 'MISROUTED', debitId: live.id, handedBack: true }] });

    const [row] = await ctx.db.select().from(debits).where(eq(debits.id, live.id));
    expect(row).toMatchObject({ state: 'FAILED', lastErrorCode: 'EXECUTED_BY_MERCHANT', attempts: 0 });
    const failed = await ctx.db.select().from(webhookOutbox).where(eq(webhookOutbox.event, 'debit.failed'));
    expect(failed.map((w) => (w.payload as { lastErrorCode: string }).lastErrorCode)).toEqual(['EXECUTED_BY_MERCHANT']);
    const [misrouted] = await ctx.db.select().from(shadowDebits).where(eq(shadowDebits.liveDebitId, live.id));
    expect(misrouted).toMatchObject({ idempotencyKey: 'inv-1', mandateRef: 'UMN-1', outcome: 'SUCCEEDED', source: 'REPORTED' });

    clock.set(live.scheduledAt);
    await ctx.worker.runOnce();
    expect(psp.calls.filter((c) => c.op === 'execute')).toEqual([]);
    // The debit's own key now replays the live debit, as first accepted.
    expect((await call('POST', `/v1/mandates/${m.id}/debits`, { amountPaise: rs(499), idempotencyKey: 'inv-1' })).json()).toMatchObject({ id: live.id, executedBy: 'MERCHANTFLO' });
  });

  it('never touches a debit Merchantflo already sent to the PSP', async () => {
    const m = await mandate('UMN-1');
    const live = await debit(m.id, 'inv-1');
    psp.enqueue({ kind: 'PENDING', settleAs: { kind: 'SUCCESS', pspTxnId: 'A-1' } });
    clock.set(live.scheduledAt);
    await ctx.worker.runOnce();
    const res = await report([{ idempotencyKey: 'inv-1', executedAt: clock.now().toISOString(), outcome: 'SUCCEEDED' }]);
    expect(res.json().results[0]).toMatchObject({ status: 'MISROUTED', handedBack: false, debitState: 'PENDING_CONFIRMATION' });
    expect((await ctx.db.select().from(debits).where(eq(debits.id, live.id)))[0]!.state).toBe('PENDING_CONFIRMATION');
  });

  it("does not hand back a debit when the report disagrees with it", async () => {
    const m = await mandate('UMN-1');
    const live = await debit(m.id, 'inv-1');
    const res = await report([{ idempotencyKey: 'inv-1', mandateRef: 'UMN-1', amountPaise: rs(1), executedAt: clock.now().toISOString(), outcome: 'SUCCEEDED' }]);
    expect(res.json().results[0]).toMatchObject({ status: 'CONFLICT' });
    expect((await ctx.db.select().from(debits).where(eq(debits.id, live.id)))[0]!.state).toBe('SCHEDULED');
  });

  it('accepts the same report as CSV', async () => {
    const csv = [
      'idempotencyKey,mandateRef,amountPaise,requestedAt,dueDate,executedAt,outcome,failureKind,failureCode,pspTxnId,attempts,orderId',
      'h-1,UMN-A,29900,,,2026-09-10T08:00:00+05:30,SUCCEEDED,,,cf_1,1,INV-1',
      'h-2,UMN-B,29900,,,2026-09-10T08:00:00+05:30,FAILED,BUSINESS,Z9,,1,INV-2',
    ].join('\n');
    const res = await call('POST', '/v1/pilot/executions', csv, { 'content-type': 'text/csv' });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toMatchObject({ created: 2 });
    const rows = await ctx.db.select().from(shadowDebits);
    expect(rows.map((r) => [r.idempotencyKey, r.outcome, r.failureKind, r.orderId]).sort()).toEqual([
      ['h-1', 'SUCCEEDED', null, 'INV-1'],
      ['h-2', 'FAILED', 'BUSINESS', 'INV-2'],
    ]);
  });
});
