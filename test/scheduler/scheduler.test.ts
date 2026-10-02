import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../src/clock.js';
import type { DbHandle } from '../../src/db/client.js';
import { debits, paymentAttempts, savingsEvents, webhookOutbox } from '../../src/db/schema.js';
import { MockPsp, type MockPspOptions } from '../../src/psp/mock.js';
import { HealthTracker } from '../../src/routing/health.js';
import { Router } from '../../src/routing/router.js';
import { SchedulerService } from '../../src/scheduler/service.js';
import { DebitWorker } from '../../src/scheduler/worker.js';
import { isRestricted } from '../../src/rules/windows.js';
import { toIst } from '../../src/rules/time.js';
import { DEFAULT_WINDOWS } from '../../src/config/rules.js';
import { AppError } from '../../src/errors.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';
import type { PspResult } from '../../src/psp/types.js';

const OK: PspResult = { kind: 'SUCCESS', pspTxnId: 'ok' };
const BANK_DOWN: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
const NO_FUNDS: PspResult = { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' };

describe('Engine A — peak-aware AutoPay scheduler', () => {
  let h: DbHandle;
  let clock: FakeClock;
  let pspA: MockPsp;
  let pspB: MockPsp;
  let service: SchedulerService;
  let worker: DebitWorker;
  let merchantId: string;
  let mandateId: string;

  async function setup(a: MockPspOptions = {}, b: MockPspOptions = {}, eligible = ['pspA', 'pspB']) {
    h = await freshDb();
    clock = new FakeClock(ist('2026-10-15T10:30:00')); // inside the morning peak
    pspA = new MockPsp('pspA', a);
    pspB = new MockPsp('pspB', b);
    const router = new Router([pspA, pspB], new HealthTracker({}, clock), clock, clock.sleep, { random: () => 0.5 });
    service = new SchedulerService({ db: h.db, clock, router });
    worker = new DebitWorker({ db: h.db, clock, router });
    merchantId = (await seedMerchant(h.db)).id;
    mandateId = (await seedMandate(h.db, merchantId, { eligiblePsps: eligible })).id;
  }

  afterEach(async () => h?.close());

  const create = (over: Partial<{ amountPaise: number; idempotencyKey: string; dueDate: string }> = {}) =>
    service.createDebit(merchantId, mandateId, { amountPaise: rs(499), idempotencyKey: 'inv-1', ...over });
  const load = async (id: string) => (await h.db.select().from(debits).where(eq(debits.id, id)))[0]!;
  const runAt = async (d: Date) => {
    clock.set(d);
    return worker.runOnce();
  };

  describe('intake', () => {
    beforeEach(() => setup());

    it('a 10:30 AM request sends the 24h notice now and schedules off-peak tomorrow', async () => {
      const { debit, created } = await create();
      expect(created).toBe(true);
      expect(debit.state).toBe('SCHEDULED');
      expect(debit.requestedInPeak).toBe(true);
      expect(debit.noticeDate).toBe('2026-10-16');
      expect(debit.scheduledAt.getTime()).toBeGreaterThanOrEqual(ist('2026-10-16T13:00:00').getTime());
      expect(debit.scheduledAt.getTime()).toBeLessThan(ist('2026-10-16T17:00:00').getTime());
      expect(debit.scheduledAt.getTime() - clock.now().getTime()).toBeGreaterThanOrEqual(24 * 3600_000);
      expect(pspA.notices).toEqual([
        { noticeRef: debit.id, mandateRef: 'UMN-123@psp', amountPaise: rs(499), executionDate: '2026-10-16' },
      ]);
      const hooks = await h.db.select().from(webhookOutbox);
      expect(hooks.map((w) => w.event)).toEqual(['debit.scheduled']);
    });

    it('honours a later due date', async () => {
      const { debit } = await create({ dueDate: '2026-10-20' });
      expect(debit.noticeDate).toBe('2026-10-20');
      expect(toIst(debit.scheduledAt).date).toBe('2026-10-20');
    });

    it('is idempotent on the merchant idempotency key', async () => {
      const first = await create();
      const second = await create();
      expect(second.created).toBe(false);
      expect(second.debit.id).toBe(first.debit.id);
      expect(pspA.notices).toHaveLength(1);
    });

    it('rejects reuse of an idempotency key with a different amount', async () => {
      await create();
      await expect(create({ amountPaise: rs(999) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('rejects amounts above the mandate limit', async () => {
      await expect(create({ amountPaise: rs(20000) })).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_MANDATE' });
    });

    it('rejects unknown mandates', async () => {
      await expect(service.createDebit(merchantId, 'mdt_nope', { amountPaise: 1, idempotencyKey: 'x' })).rejects.toBeInstanceOf(AppError);
    });
  });

  it('does not create a debit when the pre-debit notice cannot be sent', async () => {
    await setup({ failNotices: true });
    await expect(create()).rejects.toMatchObject({ code: 'NOTICE_FAILED' });
    expect(await h.db.select().from(debits)).toHaveLength(0);
  });

  describe('execution', () => {
    it('does nothing before the slot, then executes and records the peak-hour rescue', async () => {
      await setup({ script: [OK] });
      const { debit } = await create();
      expect(await runAt(new Date(debit.scheduledAt.getTime() - 1000))).toBe(0);
      expect(await runAt(debit.scheduledAt)).toBe(1);
      const d = await load(debit.id);
      expect(d.state).toBe('SUCCEEDED');
      expect(d.attempts).toBe(1);
      expect(isRestricted(d.completedAt!, DEFAULT_WINDOWS)).toBe(false);
      const savings = await h.db.select().from(savingsEvents);
      expect(savings.map((s) => [s.type, s.amountPaise])).toEqual([['PEAK_DEFERRAL_RESCUED', rs(499)]]);
      const hooks = await h.db.select().from(webhookOutbox);
      expect(hooks.map((w) => w.event)).toEqual(['debit.scheduled', 'debit.succeeded']);
    });

    it('fails over between PSPs and records the technical-decline recovery', async () => {
      await setup({ script: [BANK_DOWN] }, { script: [OK] });
      clock.set(ist('2026-10-15T14:00:00')); // requested off-peak, so the rescue is attributed to routing
      const { debit } = await create();
      await runAt(debit.scheduledAt);
      const d = await load(debit.id);
      expect(d.state).toBe('SUCCEEDED');
      expect(d.attempts).toBe(1); // one mandate attempt, two PSP calls
      expect(await h.db.select().from(paymentAttempts).where(eq(paymentAttempts.debitId, debit.id))).toHaveLength(2);
      const savings = await h.db.select().from(savingsEvents);
      expect(savings.map((s) => [s.type, s.amountPaise])).toEqual([['TD_RECOVERED', rs(499)]]);
    });

    it('reschedules technical declines into a later off-peak slot and fails after maxAttempts', async () => {
      await setup({ script: [BANK_DOWN, BANK_DOWN, BANK_DOWN] }, {}, ['pspA']);
      const { debit } = await create();
      clock.set(ist('2026-10-16T13:05:00'));
      await h.db.update(debits).set({ scheduledAt: clock.now() }).where(eq(debits.id, debit.id));

      await worker.runOnce();
      let d = await load(debit.id);
      expect(d.state).toBe('SCHEDULED');
      expect(d.attempts).toBe(1);
      expect(d.lastErrorCode).toBe('BANK_UNAVAILABLE');
      expect(d.scheduledAt.getTime()).toBeGreaterThanOrEqual(clock.now().getTime() + 30 * 60_000);
      expect(isRestricted(d.scheduledAt, DEFAULT_WINDOWS)).toBe(false);
      expect(d.noticeDate).toBe('2026-10-16'); // same-day retry keeps the original notice

      await runAt(d.scheduledAt);
      d = await load(debit.id);
      await runAt(d.scheduledAt);
      d = await load(debit.id);
      expect(d.state).toBe('FAILED');
      expect(d.attempts).toBe(3);
      const hooks = (await h.db.select().from(webhookOutbox)).map((w) => w.event);
      expect(hooks.at(-1)).toBe('debit.failed');
    });

    it('fails immediately on a business decline without consuming more attempts', async () => {
      await setup({ script: [NO_FUNDS] });
      const { debit } = await create();
      await runAt(debit.scheduledAt);
      const d = await load(debit.id);
      expect(d.state).toBe('FAILED');
      expect(d.attempts).toBe(1);
      expect(d.lastErrorCode).toBe('INSUFFICIENT_FUNDS');
      expect(pspB.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
    });

    it('refuses to execute inside a peak window even if a row is due then', async () => {
      await setup({ script: [OK] });
      const { debit } = await create();
      const peak = ist('2026-10-16T10:30:00');
      await h.db.update(debits).set({ scheduledAt: peak }).where(eq(debits.id, debit.id));
      await runAt(peak);
      const d = await load(debit.id);
      expect(d.state).toBe('SCHEDULED');
      expect(d.attempts).toBe(0);
      expect(pspA.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
      expect(isRestricted(d.scheduledAt, DEFAULT_WINDOWS)).toBe(false);
      expect(toIst(d.scheduledAt).date).toBe('2026-10-16');
    });

    it('re-sends the pre-debit notice when a retry would fall on a different date', async () => {
      await setup({ script: [BANK_DOWN] }, {}, ['pspA']);
      const { debit } = await create();
      const late = ist('2026-10-16T16:50:00');
      await h.db.update(debits).set({ scheduledAt: late }).where(eq(debits.id, debit.id));
      await runAt(late);
      const d = await load(debit.id);
      expect(d.state).toBe('SCHEDULED');
      expect(d.noticeDate).not.toBe('2026-10-16');
      expect(pspA.notices).toHaveLength(2);
      expect(pspA.notices[1]!.executionDate).toBe(d.noticeDate);
      expect(d.scheduledAt.getTime() - late.getTime()).toBeGreaterThanOrEqual(24 * 3600_000);
    });

    it('never executes on a date other than the notified one', async () => {
      await setup({ script: [OK] });
      const { debit } = await create();
      const nextDay = ist('2026-10-17T14:00:00'); // e.g. worker was down for a day
      await h.db.update(debits).set({ scheduledAt: nextDay }).where(eq(debits.id, debit.id));
      await runAt(nextDay);
      const d = await load(debit.id);
      expect(d.state).toBe('SCHEDULED');
      expect(d.attempts).toBe(0);
      expect(pspA.calls.filter((c) => c.op === 'execute')).toHaveLength(0);
      expect(d.noticeDate).toBe(toIst(d.scheduledAt).date);
      expect(pspA.notices).toHaveLength(2);
    });

    it('parks PENDING debits and confirms them via status later', async () => {
      await setup({ script: [{ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } }] });
      const { debit } = await create();
      await runAt(debit.scheduledAt);
      let d = await load(debit.id);
      expect(d.state).toBe('PENDING_CONFIRMATION');
      pspA.settle(d.lastTxnRef!, OK);
      await runAt(d.scheduledAt);
      d = await load(debit.id);
      expect(d.state).toBe('SUCCEEDED');
      expect(pspA.calls.filter((c) => c.op === 'execute')).toHaveLength(1); // never re-debited
    });

    it('recovers debits stuck in EXECUTING after a crash by checking status, not re-debiting', async () => {
      await setup({ script: [OK] });
      const { debit } = await create();
      // Simulate: worker claimed, sent to PSP (which succeeded), then crashed before saving.
      clock.set(debit.scheduledAt);
      const base = `${debit.id}-a1`;
      await pspA.executeMandate({ txnRef: `${base}-1`, mandateRef: 'UMN-123@psp', amountPaise: rs(499) });
      await h.db.update(debits).set({ state: 'EXECUTING', attempts: 1, lastTxnRef: base, executingSince: clock.now() }).where(eq(debits.id, debit.id));
      clock.advance(10 * 60_000);
      await worker.runOnce();
      const d = await load(debit.id);
      expect(d.state).toBe('SUCCEEDED');
      expect(pspA.calls.filter((c) => c.op === 'execute')).toHaveLength(1);
    });
  });

});
