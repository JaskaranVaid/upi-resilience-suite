import { beforeEach, describe, expect, it } from 'vitest';
import { IssueAnalytics } from '../../src/analytics/issues.js';
import { resolvePeriod } from '../../src/analytics/period.js';
import type { Db } from '../../src/db/client.js';
import { paymentCases, payments, paymentTracking, udirComplaints } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import type { CaseReason, CaseResolution, CaseStatus } from '../../src/tracking/types.js';
import { freshDb, ist, rs, seedMerchant } from '../helpers/fixtures.js';

const OCT = resolvePeriod({ month: '2026-10' }, ist('2026-10-15T12:00:00'));

describe('IssueAnalytics', () => {
  let db: Db;
  let merchantId: string;

  beforeEach(async () => {
    ({ db } = await freshDb());
    merchantId = (await seedMerchant(db)).id;
  });

  async function issue(o: {
    amount: number;
    reason: CaseReason;
    status: CaseStatus;
    opened: string;
    resolved?: string;
    resolution?: CaseResolution;
    reversalCompleted?: string;
    complaint?: { status: 'SUBMITTED' | 'IN_PROGRESS' | 'RESOLVED_REVERSED' | 'REJECTED'; mode: 'MOCK' | 'LIVE'; raised: string };
    merchant?: string;
  }) {
    const m = o.merchant ?? merchantId;
    const pay = newId('pay');
    const trk = newId('trk');
    const cas = newId('cas');
    await db.insert(payments).values({ id: pay, merchantId: m, amountPaise: o.amount, payerVpa: 'ab@ok', idempotencyKey: pay, state: 'FAILED', createdAt: ist(o.opened), updatedAt: ist(o.opened) });
    await db.insert(paymentTracking).values({
      id: trk, merchantId: m, subjectType: 'COLLECT', subjectId: pay, customerDebit: 'DEBITED', verificationStatus: 'RESOLVED',
      reversalStatus: o.reversalCompleted ? 'COMPLETED' : 'NONE', reversalCompletedAt: o.reversalCompleted ? ist(o.reversalCompleted) : null,
    });
    await db.insert(paymentCases).values({
      id: cas, merchantId: m, subjectType: 'COLLECT', subjectId: pay, trackingId: trk, reason: o.reason, status: o.status,
      resolution: o.resolution ?? null, openedAt: ist(o.opened), resolvedAt: o.resolved ? ist(o.resolved) : null,
    });
    if (o.complaint) {
      await db.insert(udirComplaints).values({
        id: newId('cmp'), caseId: cas, merchantId: m, pspId: 'pspA', mode: o.complaint.mode, pspComplaintRef: 'R', reasonCode: 'DEBITED_NOT_CREDITED',
        status: o.complaint.status, raisedAt: ist(o.complaint.raised), lastStatusAt: ist(o.complaint.raised),
      });
    }
  }

  it('summarises issues opened, resolved, time to resolve, reversals and UDIR complaints', async () => {
    await issue({ amount: rs(2500), reason: 'DEBITED_NOT_CAPTURED', status: 'RESOLVED', opened: '2026-10-02T10:00:00', resolved: '2026-10-02T14:00:00', resolution: 'REVERSED_TO_CUSTOMER', reversalCompleted: '2026-10-02T14:00:00' });
    await issue({ amount: rs(1000), reason: 'DEBITED_NOT_CAPTURED', status: 'RESOLVED', opened: '2026-10-03T10:00:00', resolved: '2026-10-04T10:00:00', resolution: 'COMPLAINT_RESOLVED', reversalCompleted: '2026-10-04T10:00:00', complaint: { status: 'RESOLVED_REVERSED', mode: 'MOCK', raised: '2026-10-03T12:00:00' } });
    await issue({ amount: rs(500), reason: 'VERIFICATION_EXHAUSTED', status: 'NEEDS_ACTION', opened: '2026-10-05T10:00:00' });
    await issue({ amount: rs(800), reason: 'STATUS_MISMATCH', status: 'INVESTIGATING', opened: '2026-10-06T10:00:00', complaint: { status: 'IN_PROGRESS', mode: 'LIVE', raised: '2026-10-06T11:00:00' } });
    // Opened last month, resolved this month: counts as resolved in October, not opened.
    await issue({ amount: rs(300), reason: 'DEBITED_NOT_CAPTURED', status: 'RESOLVED', opened: '2026-09-29T10:00:00', resolved: '2026-10-01T10:00:00', resolution: 'NOT_DEBITED' });
    // Another merchant: excluded.
    await issue({ amount: rs(9999), reason: 'DEBITED_NOT_CAPTURED', status: 'NEEDS_ACTION', opened: '2026-10-05T10:00:00', merchant: (await seedMerchant(db)).id });

    const s = await new IssueAnalytics({ db }).summary(merchantId, OCT);
    expect(s.opened.total).toBe(4);
    expect(s.opened.byReason).toEqual(
      expect.arrayContaining([
        { reason: 'DEBITED_NOT_CAPTURED', label: 'Customer debited, payment not captured', count: 2 },
        { reason: 'VERIFICATION_EXHAUSTED', label: 'Payment could not be verified automatically', count: 1 },
        { reason: 'STATUS_MISMATCH', label: expect.stringMatching(/Captured after failure/), count: 1 },
      ]),
    );
    expect(s.resolved.total).toBe(3);
    expect(s.resolved.byResolution).toEqual(
      expect.arrayContaining([
        { resolution: 'REVERSED_TO_CUSTOMER', label: 'Reversed to customer', count: 1 },
        { resolution: 'COMPLAINT_RESOLVED', label: 'UDIR complaint resolved', count: 1 },
        { resolution: 'NOT_DEBITED', label: 'Customer was not debited', count: 1 },
      ]),
    );
    // Durations: 4h, 24h, 48h → median 24h
    expect(s.resolved.medianTimeToResolutionMs).toBe(24 * 3600_000);
    expect(s.reversalsCompleted).toEqual({ count: 2, amountPaise: rs(3500) });
    expect(s.complaints).toMatchObject({ raised: 2, simulated: 1, live: 1 });
    expect(s.complaints.byStatus).toEqual(expect.arrayContaining([{ status: 'RESOLVED_REVERSED', label: expect.any(String), count: 1 }]));
    expect(s.now).toMatchObject({ needsAction: 1 });
    expect(s.now.openByStatus.find((x: { status: string }) => x.status === 'INVESTIGATING')!.count).toBe(1);
  });

  it('is empty, not erroring, when nothing happened', async () => {
    const s = await new IssueAnalytics({ db }).summary(merchantId, OCT);
    expect(s).toMatchObject({ opened: { total: 0 }, resolved: { total: 0, medianTimeToResolutionMs: null }, reversalsCompleted: { count: 0, amountPaise: 0 }, complaints: { raised: 0 } });
  });
});
