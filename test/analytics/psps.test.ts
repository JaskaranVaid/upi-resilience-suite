import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/analytics/period.js';
import { PspAnalytics } from '../../src/analytics/psps.js';
import type { Db } from '../../src/db/client.js';
import { paymentAttempts } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { freshDb, ist, seedMerchant } from '../helpers/fixtures.js';

const OCT = resolvePeriod({ month: '2026-10' }, ist('2026-10-15T12:00:00'));

describe('PspAnalytics', () => {
  let db: Db;
  let merchantId: string;

  beforeEach(async () => {
    ({ db } = await freshDb());
    merchantId = (await seedMerchant(db)).id;
  });

  const attempt = (pspId: string, outcome: string, latencyMs: number, at = '2026-10-10T12:00:00', extra: { code?: string; op?: string; merchant?: string } = {}) =>
    db.insert(paymentAttempts).values({
      id: newId('att'), merchantId: extra.merchant ?? merchantId, paymentId: newId('pay'), pspId, txnRef: 't', op: extra.op ?? 'collect',
      outcome, code: extra.code ?? null, latencyMs, createdAt: ist(at),
    });

  it('summarises each provider: technical success, failure categories, customer declines, latency', async () => {
    for (const ms of [100, 200, 300, 400, 500, 600, 700, 800]) await attempt('pspA', 'SUCCESS', ms);
    await attempt('pspA', 'PENDING', 150); // customer still approving — not the provider's fault
    await attempt('pspA', 'BUSINESS_DECLINE', 120, undefined, { code: 'INSUFFICIENT_FUNDS' });
    await attempt('pspA', 'TECHNICAL_DECLINE', 5000, '2026-10-11T12:00:00', { code: 'TIMEOUT' });
    await attempt('pspA', 'TECHNICAL_DECLINE', 50, '2026-10-11T12:00:00', { code: 'BANK_UNAVAILABLE' });
    await attempt('pspA', 'SUCCESS', 999, undefined, { op: 'status' }); // status checks are not attempts
    await attempt('pspA', 'SUCCESS', 999, '2026-11-01T12:00:00'); // outside period
    await attempt('pspA', 'SUCCESS', 999, undefined, { merchant: (await seedMerchant(db)).id }); // other merchant

    const s = await new PspAnalytics({ db }).summary(merchantId, OCT, ['pspA', 'pspB']);
    const a = s.providers.find((p) => p.pspId === 'pspA')!;
    expect(a).toMatchObject({
      attempts: 12,
      succeeded: 8,
      pending: 1,
      customerDeclines: 1,
      technicalDeclines: 2,
      technicalSuccessRate: 10 / 12,
      technicalDeclinesByCategory: [
        { category: 'TIMEOUT', label: 'Timeouts', count: 1 },
        { category: 'BANK_UNAVAILABLE', label: 'Bank unavailable', count: 1 },
        { category: 'SWITCH_ERROR', label: 'Network switch errors', count: 0 },
        { category: 'PSP_ERROR', label: 'Provider errors', count: 0 },
      ],
    });
    expect(a.latencyP50Ms).toBeGreaterThan(200);
    expect(a.latencyP50Ms).toBeLessThan(700);
    expect(a.latencyP95Ms).toBeGreaterThan(800);
    expect(s.methodNote).toMatch(/Customer declines and pending approvals/);
  });

  it('includes configured providers with no traffic and a zero-filled daily series', async () => {
    await attempt('pspA', 'SUCCESS', 100, '2026-10-10T12:00:00');
    await attempt('pspA', 'TECHNICAL_DECLINE', 100, '2026-10-10T13:00:00', { code: 'TIMEOUT' });
    const s = await new PspAnalytics({ db }).summary(merchantId, OCT, ['pspA', 'pspB']);
    const b = s.providers.find((p) => p.pspId === 'pspB')!;
    expect(b).toMatchObject({ attempts: 0, technicalSuccessRate: null, latencyP50Ms: null });
    const a = s.providers.find((p) => p.pspId === 'pspA')!;
    expect(a.daily).toHaveLength(31);
    expect(a.daily.find((d) => d.date === '2026-10-10')).toEqual({ date: '2026-10-10', attempts: 2, technicalSuccessRate: 0.5 });
    expect(a.daily.find((d) => d.date === '2026-10-11')).toEqual({ date: '2026-10-11', attempts: 0, technicalSuccessRate: null });
  });

  it('labels the live routing state from the health tracker', async () => {
    const s = await new PspAnalytics({ db }).summary(merchantId, OCT, ['pspA', 'pspB', 'pspC'], [
      { pspId: 'pspA', state: 'OPEN', score: 0.2, samples: 20 },
      { pspId: 'pspB', state: 'CLOSED', score: 0.9, samples: 20 },
    ]);
    expect(s.providers.map((p) => [p.pspId, p.routing.label])).toEqual([
      ['pspA', 'Temporarily avoided'],
      ['pspB', 'Healthy'],
      ['pspC', 'No recent traffic'],
    ]);
  });
});
