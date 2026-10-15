import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rupees, toCsv } from './csv.js';
import type { IssueAnalytics } from './issues.js';
import type { SettlementAnalytics } from './settlements.js';
import type { Period } from './period.js';
import { VALUE_LINES, type ValueService } from './value.js';

const pct = (r: number | null) => (r === null ? '' : `${(r * 100).toFixed(2)}%`);
const hours = (ms: number | null) => (ms === null ? '' : `${(ms / 3600_000).toFixed(1)} h`);

export const STATEMENT_HEADER = ['section', 'metric', 'count', 'amount_inr', 'amount_paise', 'value', 'method_note'];
export const VALUE_EVENTS_HEADER = ['date_ist', 'source', 'payment_type', 'payment_id', 'order_id', 'upi_ref', 'amount_inr', 'amount_paise', 'reference'];

type Rows<T> = { rows: T[] };

/** The billing-cycle statement: value, success uplift and payment issues, plus line items. */
export class StatementService {
  constructor(private readonly deps: { db: Db; value: ValueService; issues: IssueAnalytics; settlements: SettlementAnalytics }) {}

  async summaryCsv(merchantId: string, period: Period): Promise<string> {
    const [v, u, i, s] = await Promise.all([
      this.deps.value.summary(merchantId, period),
      this.deps.value.successUplift(merchantId, period),
      this.deps.issues.summary(merchantId, period),
      this.deps.settlements.summary(merchantId, period),
    ]);
    const rows: unknown[][] = [
      ...v.lines.map((l) => ['Value delivered', l.label, l.count, rupees(l.amountPaise), l.amountPaise, l.inTotal ? 'counted in total' : 'not counted in total', l.methodNote]),
      ['Value delivered', 'Gross value (all counted sources)', '', rupees(v.grossTotalPaise), v.grossTotalPaise, '', 'Sum of the lines above marked "counted in total". Each payment is attributed to at most one source.'],
      ['Success', 'Payments sent to a provider', u.submitted, '', '', '', ''],
      ['Success', 'Actual success rate', u.succeeded, '', '', pct(u.actualSuccessRate), ''],
      ['Success', 'Success rate without recovery', u.succeeded - u.recovered, '', '', pct(u.withoutRecoverySuccessRate), u.methodNote],
      ['Success', 'Uplift (percentage points)', u.recovered, '', '', u.upliftPp === null ? '' : u.upliftPp.toFixed(2), ''],
      ['Payment issues', 'Issues opened', i.opened.total, '', '', '', ''],
      ['Payment issues', 'Issues resolved', i.resolved.total, '', '', '', ''],
      ['Payment issues', 'Median time to resolve', '', '', '', hours(i.resolved.medianTimeToResolutionMs), 'Opened to resolved, for issues resolved in the period.'],
      ['Payment issues', 'Bank auto-reversals completed', i.reversalsCompleted.count, rupees(i.reversalsCompleted.amountPaise), i.reversalsCompleted.amountPaise, '', ''],
      ['Payment issues', 'UDIR complaints raised', i.complaints.raised, '', '', `${i.complaints.live} live, ${i.complaints.simulated} simulated`, 'Simulated complaints were made against a mock PSP and never sent to NPCI.'],
      ['Settlement', 'Captured payments', s.captured.count, rupees(s.captured.amountPaise), s.captured.amountPaise, '', s.methodNote],
      ['Settlement', 'Settled to your account (net)', s.settled.count, rupees(s.settled.netPaise), s.settled.netPaise, pct(s.settledShare), ''],
      ['Settlement', 'PSP fees and taxes', '', rupees(s.settled.feesPaise), s.settled.feesPaise, '', ''],
      ['Settlement', 'Settled amount differs from captured', s.mismatched, '', '', '', ''],
      ['Settlement', 'Not yet settled', s.unsettled, '', '', '', ''],
    ];
    return toCsv(STATEMENT_HEADER, rows);
  }

  /** Every value event behind the statement totals — the audit trail for billing. */
  async valueEventsCsv(merchantId: string, period: Period): Promise<string> {
    const r = (await this.deps.db.execute(sql`
      select to_char(s.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as at, s.type, s.amount_paise, s.ref_id,
        coalesce(v.subject_type, q.subject_type) as subject_type, coalesce(v.id, q.id) as payment_id,
        coalesce(v.order_id, q.order_id) as order_id, coalesce(v.upi_rrn, q.upi_rrn) as upi_rrn
      from savings_events s
      left join merchant_payments_v v on v.id = s.ref_id and v.merchant_id = s.merchant_id
      left join lateral (
        select mv.subject_type, mv.id, mv.order_id, mv.upi_rrn from payments p
        join merchant_payments_v mv on mv.id = p.id
        where p.quote_id = s.ref_id and p.merchant_id = s.merchant_id limit 1
      ) q on s.type = 'MDR_STEERING_ACCEPTED'
      where s.merchant_id = ${merchantId} and s.created_at >= ${period.from} and s.created_at < ${period.to}
        and s.type in ('TD_RECOVERED', 'PEAK_DEFERRAL_RESCUED', 'MDR_STEERING_ACCEPTED')
      order by s.created_at, s.id
    `)) as unknown as Rows<{ at: string; type: string; amount_paise: unknown; ref_id: string; subject_type: string | null; payment_id: string | null; order_id: string | null; upi_rrn: string | null }>;
    const source = (type: string) => Object.values(VALUE_LINES).find((l) => l.type === type)?.label ?? type;
    const kind = (t: string | null) => (t === 'AUTOPAY' ? 'AutoPay' : t === 'COLLECT' ? 'Collect' : '');
    return toCsv(
      VALUE_EVENTS_HEADER,
      r.rows.map((x) => [x.at, source(x.type), kind(x.subject_type), x.payment_id, x.order_id, x.upi_rrn, rupees(Number(x.amount_paise)), Number(x.amount_paise), x.ref_id]),
    );
  }
}
