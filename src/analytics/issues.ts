import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { CASE_REASON_LABELS, CASE_RESOLUTION_LABELS, CASE_STATUS_LABELS, COMPLAINT_STATUS_LABELS } from '../events/timeline.js';
import type { CaseReason, CaseResolution, CaseStatus, ComplaintStatus } from '../tracking/types.js';
import type { Period } from './period.js';

type Rows<T> = { rows: T[] };
const n = (v: unknown) => Number(v ?? 0);

/** Payment issues (Phase 3 cases, reversals, UDIR complaints) for one merchant over a period. */
export class IssueAnalytics {
  constructor(private readonly deps: { db: Db }) {}

  async summary(merchantId: string, period: Period) {
    const { db } = this.deps;
    const q = async <T>(query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as Rows<T>).rows;
    const { from, to } = period;

    const opened = await q<{ reason: CaseReason; count: unknown }>(sql`
      select reason, count(*) as count from payment_cases
      where merchant_id = ${merchantId} and opened_at >= ${from} and opened_at < ${to} group by reason`);

    const resolved = await q<{ resolution: CaseResolution; count: unknown }>(sql`
      select resolution, count(*) as count from payment_cases
      where merchant_id = ${merchantId} and resolved_at >= ${from} and resolved_at < ${to} and resolution is not null
      group by resolution`);

    const [ttr] = await q<{ median: unknown }>(sql`
      select percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - opened_at)) * 1000) as median
      from payment_cases where merchant_id = ${merchantId} and resolved_at >= ${from} and resolved_at < ${to}`);

    const [rev] = await q<{ count: unknown; amount: unknown }>(sql`
      select count(*) as count, coalesce(sum(amount_paise), 0) as amount from merchant_payments_v
      where merchant_id = ${merchantId} and reversal_completed_at >= ${from} and reversal_completed_at < ${to}`);

    const complaints = await q<{ status: ComplaintStatus; mode: 'MOCK' | 'LIVE'; count: unknown }>(sql`
      select status, mode, count(*) as count from udir_complaints
      where merchant_id = ${merchantId} and raised_at >= ${from} and raised_at < ${to} group by status, mode`);

    const open = await q<{ status: CaseStatus; count: unknown }>(sql`
      select status, count(*) as count from payment_cases
      where merchant_id = ${merchantId} and status <> 'RESOLVED' group by status`);

    const sum = (rows: Array<{ count: unknown }>) => rows.reduce((s, r) => s + n(r.count), 0);
    const complaintByStatus = new Map<ComplaintStatus, number>();
    for (const c of complaints) complaintByStatus.set(c.status, (complaintByStatus.get(c.status) ?? 0) + n(c.count));

    return {
      period: { label: period.label, month: period.month, from, to },
      opened: {
        total: sum(opened),
        byReason: opened.map((r) => ({ reason: r.reason, label: CASE_REASON_LABELS[r.reason], count: n(r.count) })),
      },
      resolved: {
        total: sum(resolved),
        byResolution: resolved.map((r) => ({ resolution: r.resolution, label: CASE_RESOLUTION_LABELS[r.resolution], count: n(r.count) })),
        medianTimeToResolutionMs: ttr?.median === null || ttr?.median === undefined ? null : Math.round(Number(ttr.median)),
      },
      reversalsCompleted: { count: n(rev?.count), amountPaise: n(rev?.amount) },
      complaints: {
        raised: sum(complaints),
        // Simulated (mock-PSP) complaints are counted apart so they are never mistaken for real filings.
        simulated: sum(complaints.filter((c) => c.mode !== 'LIVE')), // mock or PSP sandbox
        live: sum(complaints.filter((c) => c.mode === 'LIVE')),
        byStatus: [...complaintByStatus].map(([status, count]) => ({ status, label: COMPLAINT_STATUS_LABELS[status], count })),
      },
      now: {
        needsAction: n(open.find((o) => o.status === 'NEEDS_ACTION')?.count),
        openByStatus: open.map((o) => ({ status: o.status, label: CASE_STATUS_LABELS[o.status], count: n(o.count) })),
      },
    };
  }
}
