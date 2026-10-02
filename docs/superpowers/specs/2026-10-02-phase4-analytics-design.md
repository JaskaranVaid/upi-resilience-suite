# Phase 4 — Value & Revenue-Recovery Analytics: Design

Date: 2026-10-02 · Status: **awaiting approval**
Builds on: Phases 1–3 (commit `f093298`). Source: brief §5 Phase 4.

Decisions (defaults accepted): **A1** value reported per source with method notes, conservative
headline = recovered by routing/retry · **A2** calendar month (IST) + custom range · **A3** value,
PSP performance, payment issues, monthly statement (CSV + printable) — no invoicing · **A4**
hand-rolled SVG charts, no library · **A5** all roles, read-only.

## 1. Principles
- Only the merchant's own numbers. No industry statistics (e.g. "3.6% of revenue") presented as theirs.
- Every value line carries a one-sentence **method note** from the backend explaining what is counted.
- No double counting: `savings_events` already records one attribution per payment; sums are per type.
- "Steering", never "MDR bypass". "Captured", never "settled".
- Analytics are read-only and computed on demand from existing tables (indexed). Daily rollups can be
  added later if volumes require; the API shape won't change.

## 2. Gap fixes (prerequisites)
1. **Poller-confirmed collects lose routing credit.** When a collect's first attempt was a technical
   decline, the router returned PENDING, and the poller later confirmed success, `TD_RECOVERED` is not
   recorded. Fix: `TrackingService` computes `hadTechnicalDecline` from `payment_attempts` (any
   non-status `TECHNICAL_DECLINE` for that payment) before calling `applyPaymentOutcome`.
2. **Index** `payment_attempts (merchant_id, created_at)` (migration `0003`).

## 3. Periods (`src/analytics/period.ts`, pure)
`resolvePeriod({ month?: 'YYYY-MM', from?: ISO, to?: ISO }, now)` → `{ from: Date, to: Date, label, days: string[] }`
- month → [IST midnight on the 1st, IST midnight on the 1st of next month); default = current IST month.
- custom → [from, to), max 366 days, `to > from`, else `VALIDATION`.
- `days` = IST dates covered (for daily series).

## 4. Metrics

### 4.1 Value (`ValueService.summary(merchantId, period)`)
| Line | Source | Label | Method note |
|---|---|---|---|
| `routingRecovered` (**headline**) | `TD_RECOVERED` | Recovered by smart routing & safe retries | Payments whose first attempt failed for a technical reason (bank/PSP outage, timeout) and that were then captured through failover, a safe retry or status verification. |
| `peakProtected` | `PEAK_DEFERRAL_RESCUED` | Protected from the peak-hour AutoPay embargo | AutoPay debits your billing system requested during NPCI peak windows, executed off-peak and captured. Counted at full amount, assuming a peak-window attempt would have been declined. |
| `mdrSaved` | `MDR_STEERING_ACCEPTED` | MDR saved through payment-method steering | Fees avoided when customers chose the cheaper method we offered, net of the discount given. |
| `mdrOffered` (secondary) | `MDR_STEERING_OFFERED` minus accepted | Further MDR savings offered but not taken | Savings available on carts where the customer kept UPI. Not counted in totals. |

Response: `{ period, headline: line, lines: Line[], grossTotalPaise (routing + peak + mdrSaved), daily: [{ date, routingRecoveredPaise, peakProtectedPaise, mdrSavedPaise }] }`,
`Line = { key, label, count, amountPaise, methodNote }`.

### 4.2 Success uplift (`ValueService.successUplift`)
Over payments (collects + AutoPay debits) whose **first PSP attempt** falls in the period:
- `submitted` = count; `actualSuccessRate` = finally `SUCCEEDED` / submitted;
  `recovered` = succeeded **and** first attempt was a `TECHNICAL_DECLINE`;
  `withoutRecoverySuccessRate` = (succeeded − recovered) / submitted; `upliftPp` = difference in points.
- *Revised during implementation:* the draft compared against "first attempt returned SUCCESS", but
  a real UPI collect's first response is normally `PENDING` (customer approves in their app), which
  would make the baseline near zero and overstate uplift. The counterfactual is "the first attempt
  did not fail technically", which also reconciles with the `TD_RECOVERED` value line.
- "First attempt" is ordered by `created_at` then `payment_attempts.seq` (new column; attempts from
  one routing call share a timestamp).
- Method note: "Without recovery = payments that succeeded and whose first attempt had no technical
  failure: what a single-PSP integration without retries or status checks would have achieved on
  the same traffic. Peak-hour protection is reported separately."

### 4.3 PSP performance (`PspAnalytics.summary`)
Per PSP over `execute`/`collect` attempts in period: `attempts`, `succeeded`, `technicalDeclines`
(by category: Timeouts, Bank unavailable, Network switch errors, Provider errors — our normalized
categories, never raw PSP codes), `customerDeclines`, `technicalSuccessRate` = succeeded /
(attempts − customerDeclines), `latencyP50Ms`, `latencyP95Ms` (`percentile_cont`), daily
`technicalSuccessRate` series, and current routing state from the health tracker (`CLOSED`/`OPEN`/
`HALF_OPEN`, labelled "Healthy / Temporarily avoided / Being re-tested").

### 4.4 Payment issues (`IssueAnalytics.summary`)
- Cases opened in period by reason; resolved in period by resolution; median time-to-resolution.
- Bank auto-reversals completed in period: count + amount (tracking `reversal_completed_at` in period).
- UDIR complaints raised in period, by current status, with mode (MOCK counted separately and labelled).
- Snapshot now: open cases by status, cases needing action.

## 5. Monthly statement & exports
- `GET /dashboard/api/analytics/statement.csv?month=` — one row per metric:
  `section,metric,count,amount_inr,amount_paise,method_note`.
- `GET /dashboard/api/analytics/value-events.csv?month=` — line items behind the value lines:
  `date_ist,type,payment_type,payment_id,order_id,upi_ref,amount_inr,amount_paise` (audit trail for billing).
- CSV: RFC 4180 quoting; cells starting with `= + - @` or tab/CR prefixed with `'` (formula-injection
  safe); `Content-Disposition: attachment; filename="statement-<merchant>-<YYYY-MM>.csv"`; `Cache-Control: no-store`.
- Printable statement: dashboard view with `@media print` styles (no nav, light colours, page breaks).

## 6. API (`/dashboard/api/analytics`, any role, merchant-scoped)
| Method & path | Returns |
|---|---|
| `GET /value?month= \| from&to` | §4.1 + §4.2 |
| `GET /psps?month= \| from&to` | §4.3 |
| `GET /issues?month= \| from&to` | §4.4 |
| `GET /statement.csv?month=`, `GET /value-events.csv?month=` | §5 |

## 7. Frontend
New nav item **Value**, tabs: *Value delivered* · *PSP performance* · *Payment issues* · *Monthly statement*.
Month picker (default current month) + custom range. Components: `charts.js` (bar chart for daily
value, line chart for daily PSP success rate; inline SVG, CSS-variable colours, accessible titles
and data tables as fallback). Statement tab: summary table + "Download CSV" ×2 + "Print".
No business logic in the browser: all numbers, labels and method notes come from the API.

## 8. Testing
Pure: period resolution (IST month boundaries, custom range limits). Integration on PGlite:
value lines from seeded savings events (no double count, headline = routing), poller-confirmed
collect now credited (gap 1), success uplift maths, PSP percentiles/categories/rates, issue summary,
CSV columns/quoting/injection escaping/headers, merchant isolation, viewer access, invalid periods.
Static: new modules parse, no inline styles. Manual: browser walkthrough of all tabs + print preview.
