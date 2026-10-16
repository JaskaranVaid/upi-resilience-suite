import { and, count, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { rupees, toCsv } from '../analytics/csv.js';
import type { Period } from '../analytics/period.js';
import type { Db } from '../db/client.js';
import { shadowDebits, type ShadowSource } from '../db/schema.js';
import { classifyShadow, inRestrictedWindow, SHADOW_CLASSES, type ShadowClass, type ShadowValue } from './classify.js';

export interface ShadowReportOptions {
  /** Live debits with a technical first attempt needed before their recovery rate is used as an estimate. */
  minRecoverySample: number;
  /** How far back (from the period's end) the recovery rate is measured. */
  recoveryLookbackDays: number;
}

export const DEFAULT_SHADOW_REPORT: ShadowReportOptions = { minRecoverySample: 20, recoveryLookbackDays: 90 };

export const SHADOW_CSV_HEADER = [
  'shadow_debit_id', 'source', 'mandate_ref', 'order_id', 'amount_inr', 'amount_paise', 'requested_at_ist', 'executed_at_ist', 'planned_at_ist',
  'outcome', 'failure_kind', 'failure_code', 'in_restricted_window', 'class', 'value',
];

const CLASS_ORDER = Object.keys(SHADOW_CLASSES) as ShadowClass[];

const ESTIMATE_NOTE =
  'Potential value × the share of your own live Merchantflo debits whose first attempt failed for a technical reason and that were still captured (last 90 days, at least 20 debits). Without enough live traffic there is no estimate, only the upper bound.';
const COVERAGE_NOTE = 'Share of the debits your system executed this period (sent to Merchantflo as shadow debits) whose outcome you have reported. Unreported debits are left out of every number above.';

type Row = Pick<
  typeof shadowDebits.$inferSelect,
  'id' | 'source' | 'mandateRef' | 'orderId' | 'amountPaise' | 'requestedAt' | 'executedAt' | 'plannedAt' | 'outcome' | 'failureKind' | 'failureCode' | 'wouldRefuse'
>;
type Rows<T> = { rows: T[] };

const istText = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(', ', ' ') : '';

/**
 * "What you would have saved": the merchant's own executions during shadow (or history, for a
 * backtest), classified by what Merchantflo would have done differently. Conservative by design —
 * certain value only where the failure was technical and inside a window Merchantflo never uses.
 */
export class ShadowReportService {
  private readonly opts: ShadowReportOptions;

  constructor(private readonly deps: { db: Db; opts?: Partial<ShadowReportOptions> }) {
    this.opts = { ...DEFAULT_SHADOW_REPORT, ...deps.opts };
  }

  /** The merchant's own reported executions in the period (misrouted reports of our debits excluded). */
  private async rows(merchantId: string, period: Period): Promise<Array<Row & { cls: ShadowClass }>> {
    const rows = await this.deps.db
      .select({
        id: shadowDebits.id, source: shadowDebits.source, mandateRef: shadowDebits.mandateRef, orderId: shadowDebits.orderId, amountPaise: shadowDebits.amountPaise,
        requestedAt: shadowDebits.requestedAt, executedAt: shadowDebits.executedAt, plannedAt: shadowDebits.plannedAt, outcome: shadowDebits.outcome,
        failureKind: shadowDebits.failureKind, failureCode: shadowDebits.failureCode, wouldRefuse: shadowDebits.wouldRefuse,
      })
      .from(shadowDebits)
      .where(
        and(
          eq(shadowDebits.merchantId, merchantId),
          isNull(shadowDebits.liveDebitId),
          isNotNull(shadowDebits.outcome),
          gte(shadowDebits.executedAt, period.from),
          lt(shadowDebits.executedAt, period.to),
        ),
      )
      .orderBy(shadowDebits.executedAt, shadowDebits.id);
    return rows.map((r) => ({ ...r, cls: classifyShadow({ outcome: r.outcome!, executedAt: r.executedAt!, failureKind: r.failureKind, wouldRefuse: r.wouldRefuse }) }));
  }

  async summary(merchantId: string, period: Period) {
    const rows = await this.rows(merchantId, period);
    const byClass = new Map(CLASS_ORDER.map((k) => [k, { count: 0, amountPaise: 0 }]));
    const bySource: Record<ShadowSource, number> = { MIRRORED: 0, REPORTED: 0 };
    let succeeded = 0;
    for (const r of rows) {
      const c = byClass.get(r.cls)!;
      c.count++;
      c.amountPaise += r.amountPaise;
      bySource[r.source]++;
      if (r.outcome === 'SUCCEEDED') succeeded++;
    }
    const total = rows.length;
    const valueOf = (v: ShadowValue) => CLASS_ORDER.filter((k) => SHADOW_CLASSES[k].value === v).reduce((s, k) => s + byClass.get(k)!.amountPaise, 0);
    const countOf = (v: ShadowValue) => CLASS_ORDER.filter((k) => SHADOW_CLASSES[k].value === v).reduce((s, k) => s + byClass.get(k)!.count, 0);
    const certainPaise = valueOf('CERTAIN');
    const potentialPaise = valueOf('POTENTIAL');
    const rate = (x: number) => (total === 0 ? null : x / total);
    const recovery = await this.recoveryRate(merchantId, period.to);
    const coverage = await this.coverage(merchantId, period);

    return {
      period: { label: period.label, month: period.month, from: period.from, to: period.to },
      observed: { count: total, amountPaise: rows.reduce((s, r) => s + r.amountPaise, 0), succeeded, successRate: rate(succeeded) },
      classes: CLASS_ORDER.map((key) => ({ key, ...SHADOW_CLASSES[key], ...byClass.get(key)! })),
      /** Value Merchantflo would certainly have protected. */
      certainPaise,
      /** Value it could have protected at most (an upper bound; never added to the certain value). */
      potentialPaise,
      estimate:
        recovery.sample >= this.opts.minRecoverySample && recovery.rate !== null
          ? { recoveryRate: recovery.rate, sample: recovery.sample, amountPaise: Math.round(potentialPaise * recovery.rate) }
          : null,
      estimateNote: ESTIMATE_NOTE,
      projectedSuccessRate: { atLeast: rate(succeeded + countOf('CERTAIN')), atMost: rate(succeeded + countOf('CERTAIN') + countOf('POTENTIAL')) },
      bySource,
      awaitingOutcome: coverage.awaiting,
      outcomeCoverage: coverage.total === 0 ? null : (coverage.total - coverage.awaiting) / coverage.total,
      coverageNote: COVERAGE_NOTE,
    };
  }

  /** One line per classified execution: the audit trail behind the summary. */
  async rowsCsv(merchantId: string, period: Period): Promise<string> {
    const rows = await this.rows(merchantId, period);
    return toCsv(
      SHADOW_CSV_HEADER,
      rows.map((r) => [
        r.id, r.source, r.mandateRef, r.orderId, rupees(r.amountPaise), r.amountPaise, istText(r.requestedAt), istText(r.executedAt), istText(r.plannedAt),
        r.outcome, r.failureKind, r.failureCode, inRestrictedWindow(r.executedAt!) ? 'yes' : 'no', r.cls, SHADOW_CLASSES[r.cls].value.toLowerCase(),
      ]),
    );
  }

  /** Mirrored debits requested in the period (the merchant's own traffic), and how many still lack an outcome. */
  private async coverage(merchantId: string, period: Period) {
    const [r] = await this.deps.db
      .select({ total: count(), awaiting: sql<number>`count(*) filter (where ${shadowDebits.outcome} is null)` })
      .from(shadowDebits)
      .where(
        and(
          eq(shadowDebits.merchantId, merchantId),
          eq(shadowDebits.source, 'MIRRORED'),
          isNull(shadowDebits.liveDebitId),
          gte(shadowDebits.requestedAt, period.from),
          lt(shadowDebits.requestedAt, period.to),
        ),
      );
    return { total: Number(r?.total ?? 0), awaiting: Number(r?.awaiting ?? 0) };
  }

  /** Of the merchant's live debits whose first execution failed technically, the share finally captured. */
  async recoveryRate(merchantId: string, until: Date): Promise<{ rate: number | null; sample: number }> {
    const since = new Date(until.getTime() - this.opts.recoveryLookbackDays * 86_400_000);
    const r = (await this.deps.db.execute(sql`
      with firsts as (
        select distinct on (debit_id) debit_id, outcome
        from payment_attempts
        where merchant_id = ${merchantId} and debit_id is not null and op = 'execute' and not probe
          and created_at >= ${since} and created_at < ${until}
        order by debit_id, created_at, seq
      )
      select count(*) as n, count(*) filter (where d.state = 'SUCCEEDED') as recovered
      from firsts f join debits d on d.id = f.debit_id
      where f.outcome = 'TECHNICAL_DECLINE' and d.state in ('SUCCEEDED', 'FAILED')
    `)) as unknown as Rows<{ n: unknown; recovered: unknown }>;
    const n = Number(r.rows[0]?.n ?? 0);
    return { rate: n === 0 ? null : Number(r.rows[0]?.recovered ?? 0) / n, sample: n };
  }
}
