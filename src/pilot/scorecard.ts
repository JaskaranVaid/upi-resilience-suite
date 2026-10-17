import { and, count, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Period } from '../analytics/period.js';
import type { ValueService } from '../analytics/value.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { debits, duplicateSuspects, shadowDebits } from '../db/schema.js';
import { restrictedWindowExecutions } from '../ops/metrics.js';
import { differenceInterval } from './stats.js';

export type CriterionKey = 'doubleDebits' | 'restrictedWindowExecutions' | 'autopayUplift' | 'webhooksOnTime' | 'statementReconciles';
export type CriterionStatus = 'PASS' | 'FAIL' | 'PENDING' | 'NO_DATA';

export interface Criterion {
  key: CriterionKey;
  label: string;
  /** The bar, in words. */
  target: string;
  status: CriterionStatus;
  /** Whether the move to FULL requires it (uplift is reported, not gated). */
  gated: boolean;
  details: Record<string, unknown>;
  methodNote: string;
}

export interface ScorecardOptions {
  /** Share of webhooks that must arrive within `webhookDeadlineMs` of being raised. */
  webhookTarget: number;
  webhookDeadlineMs: number;
  /** A captured payment unsettled this long is overdue (the reconciler's NOT_SETTLED grace). */
  settlementGraceMs: number;
}

export const DEFAULT_SCORECARD: ScorecardOptions = { webhookTarget: 0.999, webhookDeadlineMs: 5 * 60_000, settlementGraceMs: 3 * 86_400_000 };

const NOTES: Record<CriterionKey, string> = {
  doubleDebits:
    'Suspected double debits (two successful executions of one mandate, same amount, under 24 hours apart, at least one by Merchantflo) whose second execution fell in the period, unless an operator dismissed them as legitimate. An unreviewed suspect counts until it is reviewed.',
  restrictedWindowExecutions:
    'AutoPay executions of your debits that Merchantflo started inside an NPCI peak (10:00–13:00, 17:00–21:30 IST) or blackout window, judged by when each attempt was sent, not when its answer came back.',
  autopayUplift:
    'Canary: debits Merchantflo executed while your pilot was in CANARY, with a final outcome (debits handed back to you excluded). Control: debits your own system executed in the same stage, outcome reported, excluding ones Merchantflo would have refused. Mandates are assigned to the two groups at random (by mandate id), so the difference in success rates is the uplift; the 95% interval is Newcombe\'s hybrid score method. Measurable = the whole interval is above zero.',
  webhooksOnTime:
    'Webhooks raised for you in the period that were delivered within 5 minutes of being raised. Webhooks that failed, or are still pending after 5 minutes, count as late; ones raised in the last 5 minutes are not judged yet. A webhook you asked to redeliver counts by its latest delivery.',
  statementReconciles:
    "Every payment captured in the period, and every payment behind a value line of the statement, is found in your PSP's settlement report for the same amount. Mismatches, captures still unsettled 3 days later, and value booked on payments made outside Merchantflo (nothing to check it against) fail it; captures inside the 3-day grace are pending.",
};

type Rows<T> = { rows: T[] };
const n = (v: unknown) => Number(v ?? 0);

/**
 * The pilot's pass criteria (roadmap Phase 7), measured from the product's own records for one
 * merchant and period. Four are gates for the move to FULL; uplift is the business result.
 */
export class PilotScorecard {
  private readonly opts: ScorecardOptions;

  constructor(private readonly deps: { db: Db; clock: Clock; value: ValueService; opts?: Partial<ScorecardOptions> }) {
    this.opts = { ...DEFAULT_SCORECARD, ...deps.opts };
  }

  async evaluate(merchantId: string, period: Period) {
    const criteria = await Promise.all([
      this.doubleDebits(merchantId, period),
      this.restricted(merchantId, period),
      this.uplift(merchantId, period),
      this.webhooks(merchantId, period),
      this.statement(merchantId, period),
    ]);
    return {
      period: { label: period.label, month: period.month, from: period.from, to: period.to },
      criteria,
      /** Every gated criterion passes. */
      passed: criteria.filter((c) => c.gated).every((c) => c.status === 'PASS'),
    };
  }

  private criterion(key: CriterionKey, label: string, target: string, status: CriterionStatus, details: Criterion['details'], gated = true): Criterion {
    return { key, label, target, status, gated, details, methodNote: NOTES[key] };
  }

  private async doubleDebits(merchantId: string, period: Period): Promise<Criterion> {
    const rows = await this.deps.db
      .select({ status: duplicateSuspects.status, n: count() })
      .from(duplicateSuspects)
      .where(and(eq(duplicateSuspects.merchantId, merchantId), gte(duplicateSuspects.secondAt, period.from), lt(duplicateSuspects.secondAt, period.to)))
      .groupBy(duplicateSuspects.status);
    const of = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    const open = of('OPEN');
    const confirmed = of('CONFIRMED');
    return this.criterion('doubleDebits', 'Zero double debits', '0', open + confirmed === 0 ? 'PASS' : 'FAIL', { open, confirmed, dismissed: of('DISMISSED') });
  }

  private async restricted(merchantId: string, period: Period): Promise<Criterion> {
    const c = await restrictedWindowExecutions(this.deps.db, { from: period.from, to: new Date(period.to.getTime() - 1), merchantId });
    return this.criterion('restrictedWindowExecutions', 'Zero restricted-window executions', '0', c === 0 ? 'PASS' : 'FAIL', { count: c });
  }

  private async uplift(merchantId: string, period: Period): Promise<Criterion> {
    const { db } = this.deps;
    const [canary] = await db
      .select({ n: count(), succeeded: sql<number>`count(*) filter (where ${debits.state} = 'SUCCEEDED')` })
      .from(debits)
      .where(
        and(
          eq(debits.merchantId, merchantId),
          eq(debits.rolloutStage, 'CANARY'),
          inArray(debits.state, ['SUCCEEDED', 'FAILED']),
          or(isNull(debits.lastErrorCode), ne(debits.lastErrorCode, 'EXECUTED_BY_MERCHANT')),
          gte(debits.requestedAt, period.from),
          lt(debits.requestedAt, period.to),
        ),
      );
    const [control] = await db
      .select({ n: count(), succeeded: sql<number>`count(*) filter (where ${shadowDebits.outcome} = 'SUCCEEDED')` })
      .from(shadowDebits)
      .where(
        and(
          eq(shadowDebits.merchantId, merchantId),
          eq(shadowDebits.rolloutStage, 'CANARY'),
          eq(shadowDebits.source, 'MIRRORED'),
          isNull(shadowDebits.liveDebitId),
          isNull(shadowDebits.wouldRefuse),
          isNotNull(shadowDebits.outcome),
          gte(shadowDebits.requestedAt, period.from),
          lt(shadowDebits.requestedAt, period.to),
        ),
      );
    const arm = (r: { n: number; succeeded: number } | undefined) => {
      const total = n(r?.n);
      const succeeded = n(r?.succeeded);
      return { n: total, succeeded, rate: total === 0 ? null : succeeded / total };
    };
    const a = arm(canary);
    const b = arm(control);
    const ci = differenceInterval(a.succeeded, a.n, b.succeeded, b.n);
    const status: CriterionStatus = !ci ? 'NO_DATA' : ci.low > 0 ? 'PASS' : ci.high < 0 ? 'FAIL' : 'PENDING';
    // The Phase 4 view of the same period, for context: success with vs without Merchantflo's recovery.
    const recovery = await this.deps.value.successUplift(merchantId, period);
    return this.criterion(
      'autopayUplift',
      'Measurable AutoPay uplift',
      '95% interval of (canary − control) success rate above 0',
      status,
      {
        canary: a,
        control: b,
        difference: ci?.difference ?? null,
        low: ci?.low ?? null,
        high: ci?.high ?? null,
        recoveryUpliftPp: recovery.upliftPp,
      },
      false,
    );
  }

  private async webhooks(merchantId: string, period: Period): Promise<Criterion> {
    const now = this.deps.clock.now();
    const deadline = this.opts.webhookDeadlineMs / 1000;
    const [r] = ((await this.deps.db.execute(sql`
      select
        count(*) as judged,
        count(*) filter (where delivered_at is not null and delivered_at - created_at <= make_interval(secs => ${deadline})) as on_time,
        count(*) filter (where dead_at is not null) as failed
      from webhook_outbox
      where merchant_id = ${merchantId} and created_at >= ${period.from} and created_at < ${period.to}
        and not (delivered_at is null and dead_at is null and created_at > ${new Date(now.getTime() - this.opts.webhookDeadlineMs)})
    `)) as unknown as Rows<{ judged: unknown; on_time: unknown; failed: unknown }>).rows;
    const judged = n(r?.judged);
    const onTime = n(r?.on_time);
    const share = judged === 0 ? null : onTime / judged;
    const status: CriterionStatus = share === null ? 'NO_DATA' : share >= this.opts.webhookTarget ? 'PASS' : 'FAIL';
    return this.criterion('webhooksOnTime', 'Webhooks delivered within 5 minutes', `≥ ${(this.opts.webhookTarget * 100).toFixed(1)}%`, status, {
      judged,
      onTime,
      late: judged - onTime,
      failed: n(r?.failed),
      share,
    });
  }

  private async statement(merchantId: string, period: Period): Promise<Criterion> {
    const { db, clock } = this.deps;
    const overdueBefore = new Date(clock.now().getTime() - this.opts.settlementGraceMs);
    // Captured payments of the period, plus the payment behind every value event of the period.
    const [r] = ((await db.execute(sql`
      with value_events as (
        select s.id, s.type, coalesce(q.id, case when s.type <> 'MDR_STEERING_ACCEPTED' then s.ref_id end) as payment_id
        from savings_events s
        left join lateral (
          select p.id from payments p where s.type = 'MDR_STEERING_ACCEPTED' and p.quote_id = s.ref_id and p.merchant_id = s.merchant_id and p.state = 'SUCCEEDED' limit 1
        ) q on true
        where s.merchant_id = ${merchantId} and s.created_at >= ${period.from} and s.created_at < ${period.to}
          and s.type in ('TD_RECOVERED', 'PEAK_DEFERRAL_RESCUED', 'MDR_STEERING_ACCEPTED')
      ),
      checked as (
        select v.id, v.settlement_status, coalesce(d.completed_at, p.updated_at, v.last_updated_at) as captured_at
        from merchant_payments_v v
        left join debits d on v.subject_type = 'AUTOPAY' and d.id = v.id
        left join payments p on v.subject_type = 'COLLECT' and p.id = v.id
        where v.merchant_id = ${merchantId} and v.domain_state = 'SUCCEEDED'
          and ((v.created_at >= ${period.from} and v.created_at < ${period.to}) or v.id in (select payment_id from value_events where payment_id is not null))
      )
      select
        (select count(*) from checked) as payments,
        (select count(*) from checked where settlement_status = 'SETTLED') as reconciled,
        (select count(*) from checked where settlement_status = 'MISMATCH') as mismatched,
        (select count(*) from checked where coalesce(settlement_status, 'UNSETTLED') = 'UNSETTLED' and captured_at < ${overdueBefore}) as overdue,
        (select count(*) from checked where coalesce(settlement_status, 'UNSETTLED') = 'UNSETTLED' and captured_at >= ${overdueBefore}) as awaiting,
        (select count(*) from value_events) as value_events,
        (select count(*) from value_events e where e.payment_id is null or not exists (select 1 from checked c where c.id = e.payment_id)) as unverifiable
    `)) as unknown as Rows<Record<string, unknown>>).rows;
    const d = {
      payments: n(r?.payments),
      reconciled: n(r?.reconciled),
      awaiting: n(r?.awaiting),
      overdue: n(r?.overdue),
      mismatched: n(r?.mismatched),
      valueEvents: n(r?.value_events),
      unverifiable: n(r?.unverifiable),
    };
    const status: CriterionStatus =
      d.mismatched + d.overdue + d.unverifiable > 0 ? 'FAIL' : d.awaiting > 0 ? 'PENDING' : d.payments === 0 ? 'NO_DATA' : 'PASS';
    return this.criterion('statementReconciles', 'Statement reconciles to settlement', 'every captured payment settled for the same amount', status, d);
  }
}
