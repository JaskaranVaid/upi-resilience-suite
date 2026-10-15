import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Period } from './period.js';

type Rows<T> = { rows: T[] };
const n = (v: unknown) => Number(v ?? 0);

const METHOD_NOTE =
  "From your payment providers' settlement reports, read daily. Captured = PSP-confirmed payments created in the period; settled = those found in a settlement report; fees are the PSP's charges and taxes on them. A payment is flagged when it is still unsettled 3 days after its day was reconciled.";

/** Did captured money reach the merchant's bank? Per period, from reconciled settlement reports. */
export class SettlementAnalytics {
  constructor(private readonly deps: { db: Db }) {}

  async summary(merchantId: string, period: Period) {
    const { db } = this.deps;
    const [s] = ((await db.execute(sql`
      select
        count(*) filter (where domain_state = 'SUCCEEDED') as captured,
        coalesce(sum(amount_paise) filter (where domain_state = 'SUCCEEDED'), 0) as captured_amount,
        count(*) filter (where settlement_status = 'SETTLED') as settled,
        coalesce(sum(amount_paise) filter (where settlement_status = 'SETTLED'), 0) as settled_gross,
        coalesce(sum(settled_amount_paise) filter (where settlement_status in ('SETTLED', 'MISMATCH')), 0) as settled_net,
        coalesce(sum(settlement_fee_paise) filter (where settlement_status in ('SETTLED', 'MISMATCH')), 0) as fees,
        count(*) filter (where settlement_status = 'MISMATCH') as mismatched,
        count(*) filter (where domain_state = 'SUCCEEDED' and coalesce(settlement_status, 'UNSETTLED') = 'UNSETTLED') as unsettled
      from merchant_payments_v
      where merchant_id = ${merchantId} and created_at >= ${period.from} and created_at < ${period.to}
    `)) as unknown as Rows<Record<string, unknown>>).rows;
    const [u] = ((await db.execute(sql`
      select count(*) as unmatched, coalesce(sum(amount_paise), 0) as unmatched_amount from settlements
      where merchant_id = ${merchantId} and subject_id is null and kind <> 'ADJUSTMENT'
        and settled_at >= ${period.from} and settled_at < ${period.to}
    `)) as unknown as Rows<Record<string, unknown>>).rows;
    const [overdue] = ((await db.execute(sql`
      select count(*) as n from payment_cases where merchant_id = ${merchantId} and reason = 'NOT_SETTLED' and status <> 'RESOLVED'
    `)) as unknown as Rows<Record<string, unknown>>).rows;
    const captured = n(s?.captured);
    return {
      period: { label: period.label, month: period.month, from: period.from, to: period.to },
      captured: { count: captured, amountPaise: n(s?.captured_amount) },
      settled: { count: n(s?.settled), grossPaise: n(s?.settled_gross), netPaise: n(s?.settled_net), feesPaise: n(s?.fees) },
      settledShare: captured === 0 ? null : n(s?.settled) / captured,
      mismatched: n(s?.mismatched),
      unsettled: n(s?.unsettled),
      /** Open "captured but not settled" issues, across all periods. */
      overdueNow: n(overdue?.n),
      /** Report lines we couldn't tie to any payment (e.g. payments made outside Merchantflo). */
      unmatchedLines: { count: n(u?.unmatched), amountPaise: n(u?.unmatched_amount) },
      methodNote: METHOD_NOTE,
    };
  }
}
