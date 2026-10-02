import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/analytics/period.js';
import { ValueService } from '../../src/analytics/value.js';
import type { Db } from '../../src/db/client.js';
import { debits, paymentAttempts, payments, savingsEvents, type SavingsType } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const OCT = resolvePeriod({ month: '2026-10' }, ist('2026-10-15T12:00:00'));

describe('ValueService', () => {
  let db: Db;
  let merchantId: string;
  let svc: ValueService;

  beforeEach(async () => {
    ({ db } = await freshDb());
    merchantId = (await seedMerchant(db)).id;
    svc = new ValueService({ db });
  });

  const saving = (type: SavingsType, amountPaise: number, at: string, refId = newId('pay'), merchant = merchantId) =>
    db.insert(savingsEvents).values({ id: newId('sav'), merchantId: merchant, type, amountPaise, refId, createdAt: ist(at) });

  describe('summary', () => {
    beforeEach(async () => {
      await saving('TD_RECOVERED', rs(2500), '2026-10-02T10:00:00');
      await saving('TD_RECOVERED', rs(1000), '2026-10-02T23:59:00');
      await saving('PEAK_DEFERRAL_RESCUED', rs(499), '2026-10-16T14:00:00');
      await saving('MDR_STEERING_OFFERED', rs(9), '2026-10-05T12:00:00', 'quo_taken');
      await saving('MDR_STEERING_ACCEPTED', rs(9), '2026-10-05T12:01:00', 'quo_taken');
      await saving('MDR_STEERING_OFFERED', rs(12), '2026-10-06T12:00:00', 'quo_declined');
      // Outside the period, and another merchant: excluded.
      await saving('TD_RECOVERED', rs(9999), '2026-09-30T23:59:00');
      await saving('TD_RECOVERED', rs(9999), '2026-11-01T00:00:00');
      const other = (await seedMerchant(db)).id;
      await saving('TD_RECOVERED', rs(9999), '2026-10-10T10:00:00', newId('pay'), other);
    });

    it('reports each source separately, headlined by routing recovery', async () => {
      const s = await svc.summary(merchantId, OCT);
      const byKey = Object.fromEntries(s.lines.map((l) => [l.key, [l.count, l.amountPaise]]));
      expect(byKey).toEqual({
        routingRecovered: [2, rs(3500)],
        peakProtected: [1, rs(499)],
        mdrSaved: [1, rs(9)],
        mdrOffered: [1, rs(12)], // only the offer the customer did not take
      });
      expect(s.headline.key).toBe('routingRecovered');
      expect(s.grossTotalPaise).toBe(rs(3500 + 499 + 9)); // offered-but-not-taken is excluded
    });

    it('explains every line, and never calls steering a bypass', async () => {
      const s = await svc.summary(merchantId, OCT);
      for (const l of s.lines) expect(l.methodNote.length).toBeGreaterThan(40);
      expect(JSON.stringify(s)).not.toMatch(/bypass/i);
      expect(s.lines.find((l) => l.key === 'peakProtected')!.methodNote).toMatch(/full amount/);
    });

    it('builds a zero-filled daily series bucketed by IST date', async () => {
      const s = await svc.summary(merchantId, OCT);
      expect(s.daily).toHaveLength(31);
      expect(s.daily.find((d) => d.date === '2026-10-02')).toEqual({ date: '2026-10-02', routingRecoveredPaise: rs(3500), peakProtectedPaise: 0, mdrSavedPaise: 0 });
      expect(s.daily.find((d) => d.date === '2026-10-16')!.peakProtectedPaise).toBe(rs(499));
      expect(s.daily.find((d) => d.date === '2026-10-20')).toEqual({ date: '2026-10-20', routingRecoveredPaise: 0, peakProtectedPaise: 0, mdrSavedPaise: 0 });
    });
  });

  describe('successUplift', () => {
    async function collect(final: 'SUCCEEDED' | 'FAILED' | 'PENDING', attempts: string[], at = '2026-10-10T12:00:00') {
      const id = newId('pay');
      await db.insert(payments).values({ id, merchantId, amountPaise: 100, payerVpa: 'ab@ok', idempotencyKey: id, state: final, createdAt: ist(at), updatedAt: ist(at) });
      await db.insert(paymentAttempts).values(
        attempts.map((outcome, seq) => ({ id: newId('att'), merchantId, paymentId: id, pspId: 'pspA', txnRef: `${id}-1`, op: 'collect', outcome, latencyMs: 10, seq, createdAt: ist(at) })),
      );
    }

    it('compares actual success with what a no-recovery integration would have achieved', async () => {
      await collect('SUCCEEDED', ['SUCCESS']);
      await collect('SUCCEEDED', ['TECHNICAL_DECLINE', 'SUCCESS']); // recovered
      await collect('SUCCEEDED', ['PENDING']); // customer approved later — not a recovery
      await collect('FAILED', ['TECHNICAL_DECLINE', 'TECHNICAL_DECLINE']);
      const md = await seedMandate(db, merchantId);
      const dId = newId('dbt');
      const t = ist('2026-10-11T14:00:00');
      await db.insert(debits).values({
        id: dId, merchantId, mandateId: md.id, amountPaise: 100, idempotencyKey: 'd1', state: 'FAILED', requestedAt: t, requestedInPeak: false,
        scheduledAt: t, noticeDate: '2026-10-11', noticeSentAt: t, maxAttempts: 3,
      });
      await db.insert(paymentAttempts).values({ id: newId('att'), merchantId, debitId: dId, pspId: 'pspA', txnRef: 'x', op: 'execute', outcome: 'BUSINESS_DECLINE', latencyMs: 5, createdAt: t });
      // Outside the period: excluded.
      await collect('SUCCEEDED', ['TECHNICAL_DECLINE', 'SUCCESS'], '2026-11-02T12:00:00');

      const u = await svc.successUplift(merchantId, OCT);
      expect(u).toMatchObject({ submitted: 5, succeeded: 3, recovered: 1, actualSuccessRate: 0.6, withoutRecoverySuccessRate: 0.4 });
      expect(u.upliftPp).toBeCloseTo(20, 10);
      expect(u.methodNote).toMatch(/same traffic/);
    });

    it('uses the first attempt of a payment even when a later retry happened at another time', async () => {
      await collect('SUCCEEDED', ['TECHNICAL_DECLINE'], '2026-10-10T12:00:00');
      // A later execution of the same payment (e.g. a rescheduled retry) that succeeded.
      const [p] = await db.select().from(payments);
      await db.insert(paymentAttempts).values({ id: newId('att'), merchantId, paymentId: p!.id, pspId: 'pspB', txnRef: 'y', op: 'collect', outcome: 'SUCCESS', latencyMs: 5, createdAt: ist('2026-10-10T13:00:00') });
      const u = await svc.successUplift(merchantId, OCT);
      expect(u).toMatchObject({ submitted: 1, recovered: 1, withoutRecoverySuccessRate: 0 });
    });

    it('returns zeros rather than dividing by zero for an empty period', async () => {
      expect(await svc.successUplift(merchantId, OCT)).toMatchObject({ submitted: 0, actualSuccessRate: null, withoutRecoverySuccessRate: null, upliftPp: null });
    });
  });
});
