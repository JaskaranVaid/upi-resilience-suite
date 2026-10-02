import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { TechnicalDeclineCode } from '../psp/types.js';
import type { HealthSnapshot } from '../routing/health.js';
import type { Period } from './period.js';

/** Our normalized failure categories (never raw PSP response codes). */
export const TECHNICAL_CATEGORIES: Array<{ category: TechnicalDeclineCode; label: string }> = [
  { category: 'TIMEOUT', label: 'Timeouts' },
  { category: 'BANK_UNAVAILABLE', label: 'Bank unavailable' },
  { category: 'SWITCH_ERROR', label: 'Network switch errors' },
  { category: 'PSP_ERROR', label: 'Provider errors' },
];

const ROUTING_LABELS: Record<string, string> = {
  CLOSED: 'Healthy',
  OPEN: 'Temporarily avoided',
  HALF_OPEN: 'Being re-tested',
};

const METHOD_NOTE =
  'Technical success = share of payment attempts the provider handled without an infrastructure failure (timeouts, bank or network outages). Customer declines and pending approvals do not count against the provider. Status checks are excluded.';

type Rows<T> = { rows: T[] };
const n = (v: unknown) => Number(v ?? 0);
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** How each PSP performed for one merchant over a period. */
export class PspAnalytics {
  constructor(private readonly deps: { db: Db }) {}

  async summary(merchantId: string, period: Period, pspIds: string[], health: HealthSnapshot[] = []) {
    const { db } = this.deps;
    const totals = (await db.execute(sql`
      select psp_id,
        count(*) as attempts,
        count(*) filter (where outcome = 'SUCCESS') as succeeded,
        count(*) filter (where outcome = 'PENDING') as pending,
        count(*) filter (where outcome = 'BUSINESS_DECLINE') as customer_declines,
        count(*) filter (where outcome = 'TECHNICAL_DECLINE') as technical_declines,
        count(*) filter (where outcome = 'TECHNICAL_DECLINE' and code = 'TIMEOUT') as td_timeout,
        count(*) filter (where outcome = 'TECHNICAL_DECLINE' and code = 'BANK_UNAVAILABLE') as td_bank_unavailable,
        count(*) filter (where outcome = 'TECHNICAL_DECLINE' and code = 'SWITCH_ERROR') as td_switch_error,
        count(*) filter (where outcome = 'TECHNICAL_DECLINE' and (code = 'PSP_ERROR' or code is null)) as td_psp_error,
        percentile_cont(0.5) within group (order by latency_ms) as p50,
        percentile_cont(0.95) within group (order by latency_ms) as p95
      from payment_attempts
      where merchant_id = ${merchantId} and op <> 'status' and created_at >= ${period.from} and created_at < ${period.to}
      group by psp_id
    `)) as unknown as Rows<Record<string, unknown> & { psp_id: string }>;

    const daily = (await db.execute(sql`
      select psp_id, to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day,
        count(*) as attempts, count(*) filter (where outcome = 'TECHNICAL_DECLINE') as technical_declines
      from payment_attempts
      where merchant_id = ${merchantId} and op <> 'status' and created_at >= ${period.from} and created_at < ${period.to}
      group by 1, 2
    `)) as unknown as Rows<{ psp_id: string; day: string; attempts: unknown; technical_declines: unknown }>;

    const byPsp = new Map(totals.rows.map((r) => [r.psp_id, r]));
    const healthBy = new Map(health.map((h) => [h.pspId, h]));
    // Configured PSPs first (in routing priority), then any historical ones no longer configured.
    const ids = [...pspIds, ...[...byPsp.keys()].filter((id) => !pspIds.includes(id))];

    const providers = ids.map((pspId) => {
      const r = byPsp.get(pspId);
      const attempts = n(r?.attempts);
      const technicalDeclines = n(r?.technical_declines);
      const series = new Map(period.days.map((d) => [d, { date: d, attempts: 0, technicalSuccessRate: null as number | null }]));
      for (const d of daily.rows) {
        if (d.psp_id !== pspId) continue;
        const day = series.get(d.day);
        if (!day) continue;
        day.attempts = n(d.attempts);
        day.technicalSuccessRate = day.attempts ? (day.attempts - n(d.technical_declines)) / day.attempts : null;
      }
      const h = healthBy.get(pspId);
      return {
        pspId,
        attempts,
        succeeded: n(r?.succeeded),
        pending: n(r?.pending),
        customerDeclines: n(r?.customer_declines),
        technicalDeclines,
        technicalSuccessRate: attempts ? (attempts - technicalDeclines) / attempts : null,
        technicalDeclinesByCategory: TECHNICAL_CATEGORIES.map((c) => ({
          ...c,
          count: n(r?.[`td_${c.category.toLowerCase()}`]),
        })),
        latencyP50Ms: nOrNull(r?.p50),
        latencyP95Ms: nOrNull(r?.p95),
        routing: h && h.samples > 0 ? { state: h.state, label: ROUTING_LABELS[h.state] ?? h.state } : { state: 'UNKNOWN', label: 'No recent traffic' },
        daily: [...series.values()],
      };
    });

    return { period: { label: period.label, month: period.month, from: period.from, to: period.to }, providers, methodNote: METHOD_NOTE };
  }
}
