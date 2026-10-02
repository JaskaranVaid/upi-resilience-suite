import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { savingsEvents, type SavingsType } from '../db/schema.js';
import type { Period } from './period.js';

export type ValueKey = 'routingRecovered' | 'peakProtected' | 'mdrSaved' | 'mdrOffered';

export interface ValueLine {
  key: ValueKey;
  label: string;
  count: number;
  amountPaise: number;
  /** One sentence on exactly what is counted — shown next to every number. */
  methodNote: string;
  /** Whether the line contributes to the gross total. */
  inTotal: boolean;
}

export const VALUE_LINES: Record<ValueKey, { type: SavingsType; label: string; methodNote: string; inTotal: boolean }> = {
  routingRecovered: {
    type: 'TD_RECOVERED',
    label: 'Recovered by smart routing & safe retries',
    methodNote:
      'Payments whose first attempt failed for a technical reason (bank or PSP outage, timeout) and that were then captured through failover, a safe retry or status verification.',
    inTotal: true,
  },
  peakProtected: {
    type: 'PEAK_DEFERRAL_RESCUED',
    label: 'Protected from the peak-hour AutoPay embargo',
    methodNote:
      'AutoPay debits your billing system requested during NPCI peak windows, executed off-peak and captured. Counted at full amount, assuming a peak-window attempt would have been declined.',
    inTotal: true,
  },
  mdrSaved: {
    type: 'MDR_STEERING_ACCEPTED',
    label: 'MDR saved through payment-method steering',
    methodNote: 'Fees avoided when customers chose the cheaper payment method we offered, net of the discount given to them.',
    inTotal: true,
  },
  mdrOffered: {
    type: 'MDR_STEERING_OFFERED',
    label: 'Further MDR savings offered but not taken',
    methodNote: 'Savings that were available on carts where the customer kept UPI. Shown for context; not counted in the total.',
    inTotal: false,
  },
};

const UPLIFT_NOTE =
  'Without recovery = payments that succeeded and whose first attempt had no technical failure: what a single-PSP integration without retries or status checks would have achieved on the same traffic. Payments are dated by their first attempt, and "recovered" includes AutoPay debits whose value is attributed to peak-hour protection above (value is counted once, under one source).';

type Rows<T> = { rows: T[] };
const n = (v: unknown) => Number(v ?? 0);

/** Value delivered to one merchant over a period, from the idempotent savings ledger. */
export class ValueService {
  constructor(private readonly deps: { db: Db }) {}

  async summary(merchantId: string, period: Period) {
    const { db } = this.deps;
    const inPeriod = and(eq(savingsEvents.merchantId, merchantId), gte(savingsEvents.createdAt, period.from), lt(savingsEvents.createdAt, period.to));

    const totals = await db
      .select({ type: savingsEvents.type, count: sql<number>`count(*)`, amount: sql<number>`coalesce(sum(${savingsEvents.amountPaise}), 0)` })
      .from(savingsEvents)
      .where(inPeriod)
      .groupBy(savingsEvents.type);
    const byType = new Map(totals.map((t) => [t.type, { count: n(t.count), amount: n(t.amount) }]));

    // Offers the customer did not take: offered quotes with no matching acceptance (at any time).
    const notTaken = (await db.execute(sql`
      select count(*) as count, coalesce(sum(o.amount_paise), 0) as amount
      from savings_events o
      where o.merchant_id = ${merchantId} and o.type = 'MDR_STEERING_OFFERED'
        and o.created_at >= ${period.from} and o.created_at < ${period.to}
        and not exists (select 1 from savings_events a where a.type = 'MDR_STEERING_ACCEPTED' and a.ref_id = o.ref_id)
    `)) as unknown as Rows<{ count: unknown; amount: unknown }>;

    const lines: ValueLine[] = (Object.keys(VALUE_LINES) as ValueKey[]).map((key) => {
      const def = VALUE_LINES[key];
      const v = key === 'mdrOffered' ? { count: n(notTaken.rows[0]?.count), amount: n(notTaken.rows[0]?.amount) } : (byType.get(def.type) ?? { count: 0, amount: 0 });
      return { key, label: def.label, count: v.count, amountPaise: v.amount, methodNote: def.methodNote, inTotal: def.inTotal };
    });

    const daily = (await db.execute(sql`
      select to_char(created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, type, coalesce(sum(amount_paise), 0) as amount
      from savings_events
      where merchant_id = ${merchantId} and created_at >= ${period.from} and created_at < ${period.to}
        and type in ('TD_RECOVERED', 'PEAK_DEFERRAL_RESCUED', 'MDR_STEERING_ACCEPTED')
      group by 1, 2
    `)) as unknown as Rows<{ day: string; type: SavingsType; amount: unknown }>;
    const byDay = new Map(period.days.map((d) => [d, { date: d, routingRecoveredPaise: 0, peakProtectedPaise: 0, mdrSavedPaise: 0 }]));
    for (const r of daily.rows) {
      const d = byDay.get(r.day);
      if (!d) continue;
      if (r.type === 'TD_RECOVERED') d.routingRecoveredPaise = n(r.amount);
      else if (r.type === 'PEAK_DEFERRAL_RESCUED') d.peakProtectedPaise = n(r.amount);
      else d.mdrSavedPaise = n(r.amount);
    }

    return {
      period: { label: period.label, month: period.month, from: period.from, to: period.to },
      headline: lines.find((l) => l.key === 'routingRecovered')!,
      lines,
      grossTotalPaise: lines.filter((l) => l.inTotal).reduce((s, l) => s + l.amountPaise, 0),
      daily: [...byDay.values()],
    };
  }

  /**
   * Success with the suite vs. what the same traffic would have achieved without recovery.
   * A payment counts in the period of its first PSP attempt.
   */
  async successUplift(merchantId: string, period: Period) {
    const r = (await this.deps.db.execute(sql`
      with firsts as (
        select distinct on (coalesce(payment_id, debit_id))
          coalesce(payment_id, debit_id) as subject_id, outcome, created_at
        from payment_attempts
        where merchant_id = ${merchantId} and op <> 'status'
        -- the first attempt on the PSP the router preferred: a failed health probe isn't the baseline
        order by coalesce(payment_id, debit_id), probe, created_at, seq
      )
      select
        count(*) as submitted,
        count(*) filter (where coalesce(p.state, d.state) = 'SUCCEEDED') as succeeded,
        count(*) filter (where coalesce(p.state, d.state) = 'SUCCEEDED' and f.outcome = 'TECHNICAL_DECLINE') as recovered
      from firsts f
      left join payments p on p.id = f.subject_id
      left join debits d on d.id = f.subject_id
      where f.created_at >= ${period.from} and f.created_at < ${period.to}
    `)) as unknown as Rows<{ submitted: unknown; succeeded: unknown; recovered: unknown }>;
    const submitted = n(r.rows[0]?.submitted);
    const succeeded = n(r.rows[0]?.succeeded);
    const recovered = n(r.rows[0]?.recovered);
    const rate = (x: number) => (submitted === 0 ? null : x / submitted);
    const actual = rate(succeeded);
    const without = rate(succeeded - recovered);
    return {
      submitted,
      succeeded,
      recovered,
      actualSuccessRate: actual,
      withoutRecoverySuccessRate: without,
      upliftPp: actual === null || without === null ? null : (actual - without) * 100,
      methodNote: UPLIFT_NOTE,
    };
  }
}
