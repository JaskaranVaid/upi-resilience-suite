# Phase 7 — Pilot: design

Date: 2026-10-16 · Roadmap: [Phase 7](../../roadmap.md#phase-7--pilot) · Milestone: **M2 (working model)**

## Why

Phases 1–6 built a system that works against sandboxes and is safe to stop. Phase 7 puts real money
through it for one merchant, then a second, without betting the merchant's collections on it on day
one. The roadmap fixes the sequence (shadow → canary 5–10% of mandates → 100% → second design partner)
and the pass bar:

1. zero double debits;
2. zero restricted-window executions;
3. measurable AutoPay uplift;
4. ≥ 99.9% of webhooks delivered within 5 minutes;
5. the monthly statement reconciles to the PSP's settlement report.

The pilot merchant already runs UPI AutoPay through their own billing system and PSP account (the
"legacy path"). Merchantflo has to earn the right to execute their debits: first by showing, on their
own traffic, what it would have done ("what you would have saved"), then by executing a random slice
of mandates side by side with the legacy path, then everything. Each step must be reversible at once,
and the evidence for each pass criterion must come out of the product, not a spreadsheet.

## Goals

- A per-merchant **rollout stage** — `SHADOW`, `CANARY` (with a percentage of mandates) or `FULL` —
  that operators change from the ops console, with gates, history and an audit trail.
- **One integration for the whole pilot.** The merchant sends every debit request to
  `POST /v1/mandates/:id/debits`, as in the integration guide. The response says who executes it:
  `executedBy: "MERCHANTFLO"` (we notify and execute, as today) or `executedBy: "MERCHANT"` (a
  **shadow debit**: we plan it but never notify or execute; the merchant's legacy path runs it).
- **Shadow debits cannot move money.** They live in their own table, which the worker, router and
  notice code never read.
- The merchant **reports what the legacy path did** (`POST /v1/pilot/executions`, JSON or CSV). The
  same endpoint takes a **historical export** (backtest), so a prospect can see a report before
  integrating anything.
- A **shadow report** ("what you would have saved") with conservative, method-noted lines: certain
  value, potential value (an upper bound), and what Merchantflo would not have changed.
- **Canary assignment by mandate**, deterministic and monotonic in the percentage, which gives a
  randomised controlled comparison: canary mandates (Merchantflo) against control mandates (legacy),
  in the same weeks. The AutoPay uplift is the difference in success rate with a 95% confidence
  interval.
- A **double-debit detector** (Merchantflo execution vs. another Merchantflo execution or a reported
  legacy execution of the same mandate) with an ops review queue, a gauge and an alarm.
- A **pilot scorecard** per merchant and period that evaluates the five pass criteria, each PASS /
  FAIL / PENDING / NO_DATA with its numbers and method note. It gates CANARY → FULL.
- The merchant sees their stage, shadow report and scorecard in the dashboard. Operators see every
  pilot in the ops console.
- A pilot playbook (runbook), an ADR, an integration-guide section and a pilot-terms draft for counsel.

## Non-goals

- **Checkout (one-off payments) in shadow.** Checkout steering never executes anything when only
  quoted, and Phase 4 already books its value only on confirmed payments. The pilot is about AutoPay.
- **Fetching legacy outcomes from the PSP ourselves.** We would need the legacy transaction
  references and read access the merchant may not grant. The merchant reports outcomes, and the
  report's coverage line says how many outcomes are missing.
- **Mandate porting between PSPs during the pilot.** Unchanged (fact sheet §4).
- **Pricing and billing** for pilot value: Phase 8.
- **Automatic stage changes.** The system recommends and gates; a person decides.

## Anti-goals (failure even if it "works")

- Any path where a shadow debit could reach a PSP, or a notice go out for one.
- Any change in behaviour for merchants not in a pilot. Every existing merchant stays `FULL`, and
  every existing test passes unchanged.
- A headline number that overstates value. Potential value is never added to certain value without
  a label, and an unknown failure cause is never counted as recoverable.
- A rollback that cancels debits the merchant was told we would execute, without telling them.
- Double debits caused by the hand-over itself, for example the same debit executed by both paths
  because a stage changed between a request and its retry.

## Constraints

- Expand-only migrations (ADR 0007): new tables, plus nullable or defaulted columns.
- Merchants own their PSP accounts (ADR 0002). Shadow mode never needs PSP credentials beyond what the
  merchant already connected.
- No new runtime dependencies.
- Personal data: shadow rows hold no VPA or phone number (only the mandate reference, amounts, times
  and the PSP's transaction id), so retention and erasure are unchanged.
- The NPCI peak rule has applied since 1 Aug 2025. Backtest executions before that date are never
  classified as peak-window executions.

## Design

### Rollout stage

`merchants.rollout_stage` (`SHADOW | CANARY | FULL`, default `FULL`) and `merchants.canary_percent`
(1–99, set only in `CANARY`). Every change is a row in `rollout_changes` (from/to stage and percent,
reason, operator, override flag, time) and an `operator_audit` entry, and is sent to the merchant as
the webhook `pilot.stage_changed`.

**Live money starts in shadow.** The first time a merchant switches from TEST to LIVE mode (and
has no rollout history), its stage becomes `SHADOW`, recorded as a system change. A merchant
integrating against real money therefore never has debits executed by both paths before an operator
says so. Test-mode merchants stay `FULL` unless an operator moves them, for rehearsals.

**Who executes a debit** is decided at intake, once, and stored:

| Stage | Executor |
|---|---|
| `FULL` | Merchantflo |
| `SHADOW` | Merchant |
| `CANARY p%` | Merchantflo if `bucket(mandateId) < p`, else Merchant |

`bucket(mandateId)` = the first 32 bits of SHA-256(mandate id), mod 100. Raising the percentage only
adds mandates to the canary; lowering it only removes them. The assignment is random with respect to
customers, which is what makes canary vs. control a fair comparison.

**Stage changes** (ops console, `POST /ops/api/pilots/:merchantId/stage`):

- *Backwards* (FULL → CANARY/SHADOW, CANARY → SHADOW, or a lower percentage) is always allowed
  (OWNER or OPERATOR, with a reason). It is the rollback. It affects **new** debit requests only:
  debits already accepted as `MERCHANTFLO` stay with Merchantflo and run, because the merchant was told
  so. The runbook says how to stop those too (kill switch) and hand them back.
- *Forwards* to CANARY (or a higher percentage) requires: a webhook URL; for a LIVE merchant, at
  least one ACTIVE production PSP connection; and no open duplicate suspects.
- *Forwards* to FULL requires the scorecard for the current canary period to pass criteria 1, 2, 4
  and 5 (uplift is reported, not gated). It also needs at least 7 days in canary and at least 30
  canary debits with a final outcome.
- An OWNER may override a failed gate with a reason. The override is recorded.

### Debit intake

`DebitIntake.request(merchant, mandateId, input)` replaces the route's direct call to
`SchedulerService.createDebit`:

1. An existing live debit with this idempotency key → replay it (same rules as today).
2. An existing shadow debit with this key → replay it (same mandate and amount, or
   `IDEMPOTENCY_CONFLICT`).
3. Otherwise decide the executor. `MERCHANTFLO` → `SchedulerService.createDebit` as today, with
   `debits.rollout_stage` recorded. `MERCHANT` → `ShadowService.createFromIntake`.

**Idempotency across the two tables.** Both inserts run in a transaction that first takes
`pg_advisory_xact_lock` on (merchant, key) and re-checks the other table. Two concurrent retries
around a stage change therefore cannot create one live and one shadow debit. (If the live path loses
the race after sending its notice, the customer receives a notice for a debit we then don't execute.
This is harmless and logged, and practically never happens.)

**Shadow intake** validates the mandate like live intake (404 if unknown). It never refuses the
request, because the legacy path will run the debit anyway. It records what live intake would have
refused (`wouldRefuse`: `MANDATE_INACTIVE`, `AMOUNT_EXCEEDS_MANDATE`, `AFA_REQUIRED`) and plans the
debit with the same `plan()` used live (planned execution time and notice date). It sends nothing and
calls no PSP.

Responses: live debits gain `executedBy: "MERCHANTFLO"`; a shadow debit is
`{ object: "shadow_debit", id: "shd_…", executedBy: "MERCHANT", plannedAt, plannedNoticeDate,
wouldRefuse, outcome, … }`. `GET /v1/shadow-debits/:id` and `GET /v1/shadow-debits` read them.
Mandate responses gain `executedBy`, the current assignment for new debits. `GET /v1/pilot` returns the
stage, the percentage and since when.

### Reported executions (legacy outcomes and backtests)

`POST /v1/pilot/executions`: JSON `{ executions: [...] }` (≤ 5,000 items), or `text/csv` with header
`idempotencyKey,mandateRef,amountPaise,requestedAt,dueDate,executedAt,outcome,failureKind,failureCode,pspTxnId,attempts,orderId`
(≤ 5 MB). Each item has `idempotencyKey`, `executedAt` and `outcome` (`SUCCEEDED | FAILED`).
`failureKind` (`TECHNICAL | BUSINESS | UNKNOWN`, default `UNKNOWN`) is required for the item to count
as recoverable. Raw `failureCode` is kept for the merchant's reference only, because we do not invent
an NPCI code table.

Per item, by key:

- **Matches a shadow debit** → its outcome is recorded (`RECORDED`) or replaced by a later report
  (`UPDATED`). A legacy retry that finally succeeded wins.
- **Matches a live debit** (`MISROUTED`): the merchant executed a debit Merchantflo owns. If ours is
  still `SCHEDULED`, it is handed back atomically (state FAILED, code `EXECUTED_BY_MERCHANT`,
  `debit.failed` webhook), so we never execute it as well. If ours already started, nothing can be
  undone, and the double-debit detector will flag the pair if both succeeded. The report is stored as
  a shadow row linked to the live debit.
- **Matches nothing** → a new shadow row (`source = REPORTED`), with `mandateRef` and `amountPaise`
  required. It is planned as if requested at `requestedAt` (default: `executedAt`), with the rules
  in force then. This is the backtest.

### Shadow report: "what you would have saved"

Per merchant and period, from shadow rows with a reported outcome whose `executedAt` falls in the
period. Each row falls into exactly one class:

| Class | Rule | Value |
|---|---|---|
| `WOULD_REFUSE` | amount above the no-AFA limit, or other `wouldRefuse` | none (needs customer authentication) |
| `PEAK_RESCUE` | FAILED, `TECHNICAL`, executed inside an NPCI restricted window (on/after 1 Aug 2025) | **certain**: full amount. We would have executed off-peak. |
| `RETRY_RECOVERABLE` | FAILED, `TECHNICAL`, outside restricted windows | **potential** (upper bound): a status-checked retry or failover might have captured it |
| `PEAK_RISK` | SUCCEEDED inside a restricted window | none. Counted as a compliance exposure |
| `BUSINESS_DECLINE` | FAILED, `BUSINESS` | none. Nothing we change |
| `UNCLASSIFIED_FAILURE` | FAILED, `UNKNOWN` | none. Classify failures to get credit |
| `NO_CHANGE` | SUCCEEDED off-peak | none |

Headline: certain value; potential value; and, when the merchant has live Merchantflo debits, an
*estimate* = potential × our measured recovery rate on their own traffic (live debits whose first
attempt was a technical decline and that ended SUCCEEDED), with its n. With no live data there is no
estimate, only the upper bound. Also shown: observed success rate, projected success rate (at least
observed + certain; at most observed + certain + potential), outcome coverage (shadow debits in the
period without a reported outcome), and the counts by source (mirrored or reported). CSV: one line per
shadow row with its class, for audit.

### Pilot scorecard

`PilotScorecard.evaluate(merchantId, period)` returns the five criteria. Each has a `status`
(`PASS | FAIL | PENDING | NO_DATA`), the numbers behind it, and a method note:

1. **Double debits**: duplicate suspects detected in the period that are OPEN or CONFIRMED. PASS
   only at 0. An unreviewed suspect fails until an operator dismisses it.
2. **Restricted-window executions**: execute attempts for the merchant's debits *started* inside a
   restricted window (same start-time reconstruction as the ops gauge). PASS only at 0.
3. **AutoPay uplift**: canary arm = live debits created in `CANARY` with a final outcome; control
   arm = shadow debits mirrored in `CANARY` with a reported outcome. The difference in success rates
   gets a Newcombe (Wilson score) 95% interval. PASS when the lower bound > 0, FAIL when the upper
   bound < 0, PENDING otherwise (not yet measurable), NO_DATA without both arms. The existing
   "uplift from recovery" (Phase 4) is shown alongside for context.
4. **Webhooks within 5 minutes**: of the merchant's webhooks created in the period (excluding ones
   still pending and younger than 5 minutes), the share delivered within 5 minutes of creation. PASS
   at ≥ 99.9%. A redelivered webhook counts by its latest delivery (noted).
5. **Statement reconciles**: every value event in the period (as in the statement's value-events
   CSV) is tied to a payment that settled with the same amount. FAIL on a mismatch, an overdue
   unsettled payment (past the reconciler's 3-day grace) or a value event with no payment to check
   (quotes reported paid outside Merchantflo). PENDING while payments are still within the grace
   period.

### Double-debit detector

`DuplicateDetector.runDue()` runs from the worker tick, at most every 10 minutes, over the last 7
days. Successful executions on a mandate come from two sources: live debits SUCCEEDED (time =
`executing_since`, else `completed_at`) and shadow rows reported SUCCEEDED (time = `executedAt`). Two
of them form a suspect when they are the **same merchant and mandate reference, the same amount, and
less than 24 hours apart**, and **at least one is a Merchantflo execution**. Legacy-vs-legacy pairs
are the merchant's own system and out of scope. Pairs are stored once (`duplicate_suspects`, unique
per pair) with evidence (same order id, the two times). Operators mark them CONFIRMED (real: refund
the customer, follow the runbook) or DISMISSED (legitimate, e.g. two invoices), with a note. Gauge
`duplicateDebitsOpen` in `ops.metrics` has an alarm at ≥ 1. Known limit: daily-frequency mandates
with equal amounts can produce false suspects, which operators dismiss.

### Surfaces

- **Merchant API**: `GET /v1/pilot`, `GET /v1/pilot/scorecard`, `GET /v1/pilot/report`,
  `POST /v1/pilot/executions`, `GET /v1/shadow-debits[/:id]`. All in OpenAPI and the SDK.
  Webhook `pilot.stage_changed`.
- **Dashboard**: a *Pilot* tab under Value, shown when the merchant is in a pilot or has shadow data:
  stage, scorecard, shadow report, CSV download.
- **Ops console**: a *Pilots* view (every merchant not in FULL, or with a rollout history) → detail
  with scorecard, shadow report, stage history, stage-change form with gates, and duplicate suspects
  with resolve. Also a *Duplicates* queue across merchants. Metrics view gains `duplicateDebitsOpen`.
- **Infra**: metric filter + alarm `duplicate-debit-suspected`.

### Documents

ADR 0008 (pilot rollout by mandate, intake decides the executor); runbook `pilot.md` (playbook:
entry, backtest, shadow, canary, ramp, full, second partner, rollback, duplicate handling, weekly
review); integration-guide section; `docs/legal/pilot-terms.md` draft for counsel; external actions
(pilot agreement, history export, go/no-go reviews, second partner); roadmap Phase 7 ✅ code.

## Builder's calls (made here, open to change)

- Separate `shadow_debits` table rather than a `SHADOW` state in `debits`: a structural guarantee
  that nothing executes them, and no change to the payments view or analytics.
- The rollout stage is per merchant, and canary assignment is per mandate. A per-PSP or per-amount
  canary was rejected because it would not give a fair control group.
- The first switch to LIVE mode puts a merchant in SHADOW.
- A misrouted report hands back a still-scheduled live debit automatically. This prevents double
  debits; the merchant is told by webhook.
- Duplicate rule: same mandate and amount within 24 hours. 7-day look-back, 10-minute cadence.
- Gate thresholds: 7 days and 30 final canary debits before FULL. Uplift is not gated.
- Unknown failure causes are never credited.
