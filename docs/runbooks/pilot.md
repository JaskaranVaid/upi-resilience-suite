# Runbook — Pilot

How a design partner moves its real UPI AutoPay debits onto Merchantflo: **backtest → shadow →
canary → full**, then a second partner. Each step is reversible at once, and every pass criterion
is measured by the product (ops console → **Pilots**). Design: [ADR 0008](../decisions/0008-pilot-rollout-by-mandate.md).

## The pass bar (roadmap Phase 7)

| # | Criterion | Bar | Gates FULL? |
|---|---|---|---|
| 1 | Double debits | 0 unreviewed or confirmed suspects | Yes |
| 2 | Restricted-window executions | 0 executions started inside 10:00–13:00 / 17:00–21:30 IST or a blackout | Yes |
| 3 | AutoPay uplift | 95% interval of (canary − control) success rate above 0 | No — reported |
| 4 | Webhooks | ≥ 99.9% delivered within 5 minutes | Yes |
| 5 | Statement | every captured payment settled for the same amount (3-day grace) | Yes |

Each criterion shows PASS, FAIL, PENDING (not measurable yet) or NO_DATA, with its numbers and how
it is measured (hover the criterion in the console, or open "How each criterion is measured").

## Who executes what

| Stage | Who executes a new debit | Set by |
|---|---|---|
| `SHADOW` | The merchant's own system. Merchantflo plans it, sends nothing, calls no PSP | Automatic on the merchant's first switch to LIVE; or an operator |
| `CANARY p%` | Merchantflo for mandates in buckets below `p` (fixed per mandate); the merchant for the rest | Operator |
| `FULL` | Merchantflo | Operator (default for every merchant not in a pilot) |

The merchant's integration never changes: every `POST /v1/mandates/:id/debits` response says
`executedBy: MERCHANTFLO` (we notify and execute — **they must not**) or `MERCHANT` (a shadow debit
— they execute it as before and report the outcome). A retry with the same idempotency key always
returns the first answer, even across a stage change.

## 1. Entry (before any real money)

- [ ] Pilot agreement signed ([pilot terms draft](../legal/pilot-terms.md), founder action #25).
- [ ] The merchant has the [integration guide](../integration-guide.md#9-pilots) and has handled
      both `executedBy` values in **test mode** — including reporting outcomes.
- [ ] Live merchant onboarded, production PSP connection ACTIVE, `https` webhook URL set.
- [ ] The merchant is in `SHADOW` (ops console → Pilots; a first switch to LIVE does it). If it shows
      `FULL` with no history, move it to SHADOW **before** it sends any live debit.

## 2. Backtest (optional, before integrating)

Ask for a history export (founder action #26): 1–3 months of AutoPay executions with
`idempotencyKey` (any unique id), `mandateRef`, `amountPaise`, `executedAt`, `outcome`, and
`failureKind` (`TECHNICAL`, `BUSINESS`, `UNKNOWN`). The merchant posts it as CSV to
`POST /v1/pilot/executions` (≤ 5 MB or 5,000 items per call). Each row is planned with the rules in
force at its time (the NPCI peak rule only from 1 Aug 2025).

Read the result in Pilots → merchant → **Shadow report** (period = the export's months). Only
`PEAK_RESCUE` is certain value. `RETRY_RECOVERABLE` is an upper bound; never quote it as savings.
If most failures are `UNCLASSIFIED_FAILURE`, ask the merchant to map their PSP's codes to
`failureKind` — unknown causes earn no credit, by design.

## 3. Shadow (1–2 weeks)

The merchant sends every debit to Merchantflo, gets shadow debits back, executes them as before,
and reports each outcome (`POST /v1/pilot/executions` with the same idempotency key; a later report
replaces an earlier one, so retries are safe).

Watch daily:

- **Outcome coverage** in the shadow report: below ~95% means reports are missing — fix before canary.
- `GET /v1/shadow-debits?reported=false` (merchant side) lists what still needs a report.
- `wouldRefuse` counts (`AFA_REQUIRED`, `AMOUNT_EXCEEDS_MANDATE`, `MANDATE_INACTIVE`): these would
  fail at intake in canary — the merchant should clean them up.

Exit: coverage ≥ 95%, the shadow report reviewed with the merchant, no open suspects.

## 4. Canary (start at 5%)

Ops console → Pilots → merchant → **Stage** CANARY, 5%, with the reason (e.g. "shadow report reviewed
with ⟨name⟩ on ⟨date⟩"). The gate box shows what blocks the move before you click.

From now on Merchantflo executes about 5% of mandates. Tell the merchant the day before (they also
get `pilot.stage_changed`).

Daily, the first week:

- **Duplicates** queue empty (alarm `duplicate-debit-suspected` pages on any).
- Scorecard criteria 1, 2, 4, 5 PASS or PENDING; any FAIL → [rollback](#rollback) first, investigate second.
- `debit.failed` with `lastErrorCode: EXECUTED_BY_MERCHANT` means the merchant executed one of ours
  (a misroute) and it was handed back in time. One is a warning; a pattern is a bug in their routing
  — roll back to SHADOW until fixed.

Ramp: 5% → 10% → 25% → 50% after at least 3 clean days each (a larger percentage is a forward move:
same gates). Lowering it is always allowed.

## 5. Full

The console allows FULL only from CANARY after **7 days** in the current canary stretch, **30
canary debits with a final outcome**, and criteria 1, 2, 4 and 5 passing over that stretch. Uplift is
reported, not gated: if it is PENDING (interval straddles zero), say so to the merchant — do not round
it up. An OWNER can override a failed gate with a reason; the override and the gates it overrode are
recorded in the history and the audit log. Use it only for a merchant with no legacy path.

After FULL, keep the merchant's legacy path able to run for 2 weeks (rollback insurance).

## 6. Second design partner

Same steps from §1. The first partner's scorecard (export the shadow-report CSV and screenshot the
scorecard) is the case study input for Phase 8 — with the merchant's written permission only.

## Rollback

Any FAIL on a gated criterion, a confirmed double debit, a restricted-window execution, or the
merchant asking: move the merchant **back** (CANARY lower %, or SHADOW). Rollback needs no gate and
takes effect for **new** debit requests at once.

Debits already accepted as Merchantflo's (`executedBy: MERCHANTFLO`, `SCHEDULED`) **still run** —
the merchant was told we would execute them. To take those back too:

1. Pause the merchant ([kill switch](kill-switch.md), scope "One merchant"). Its scheduled debits now
   wait; nothing is cancelled.
2. The merchant lists them with `GET /v1/debits?state=SCHEDULED` (their own API key).
3. The merchant executes them on its own path and reports each with the **same idempotency key**.
   Each report hands the debit back: FAILED with `EXECUTED_BY_MERCHANT` and a `debit.failed` webhook.
   Merchantflo never executes a handed-back debit.
4. When `GET /v1/debits?state=SCHEDULED` is empty, lift the pause.

Never lift the pause while the merchant is still executing debits that are ours: a debit that is
still `SCHEDULED` when the pause lifts runs.

## Double debits

Alarm `duplicate-debit-suspected` → [alerts runbook](alerts.md#duplicate-debit-suspected). In short:
open **Duplicates**, check both executions, roll back if Merchantflo or a misroute caused it, have the
merchant refund the customer from its PSP account, then resolve: **Confirmed** (with the refund
reference) or **Dismissed** (with what you checked — e.g. two invoices on a daily mandate). An
unreviewed suspect fails criterion 1 and blocks every forward move.

## Weekly review (every pilot, every week)

30 minutes with the merchant, then a note in the pilot history (the next stage change's reason, or
the shared pilot log):

- Scorecard for the week (`from`/`to` = last 7 days) and the month to date.
- Shadow report: certain value, potential (upper bound), coverage, top classes.
- Duplicates: any confirmed? Refunds done?
- Misroutes (`EXECUTED_BY_MERCHANT`) and `wouldRefuse` trends.
- Decision: hold, ramp, roll back — with the reason that goes in the stage change.

Go/no-go reviews before CANARY and before FULL are founder action #27.
