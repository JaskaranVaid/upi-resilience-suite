# Pilot terms (outline)

> **Draft outline for counsel** (founder action #25). Not legal advice and not ready to sign. It
> records what the pilot actually does ([pilot runbook](../runbooks/pilot.md),
> [ADR 0008](../decisions/0008-pilot-rollout-by-mandate.md)), so counsel can turn it into a short
> agreement or a schedule to the main contract and the [DPA](dpa.md).

**Parties.** ⟨Merchant⟩ (design partner) and Merchantflo ⟨legal entity⟩.

## 1. What the pilot is

A staged move of the merchant's UPI AutoPay debits from its own billing system to Merchantflo,
through the merchant's own PSP account (Merchantflo never holds funds):

1. **Backtest** (optional): the merchant shares an export of past executions; Merchantflo reports
   what it would have done.
2. **Shadow**: the merchant sends each debit to Merchantflo and executes it itself; Merchantflo only
   plans it and never contacts the customer or the PSP for it.
3. **Canary**: Merchantflo executes the debits of a random share of mandates (starting at about 5%),
   the merchant the rest. Every API response states which party executes each debit.
4. **Full**: Merchantflo executes all of the merchant's AutoPay debits.

Merchantflo moves the stage only after the weekly review with the merchant and tells it by webhook.
Either party may ask to go back a stage at any time; Merchantflo does so the same business day.

## 2. Responsibilities

| | Merchant | Merchantflo |
|---|---|---|
| Debits marked `executedBy: MERCHANT` | Executes them, reports each outcome within ⟨2 business days⟩ | Plans only; never executes, never sends a notice |
| Debits marked `executedBy: MERCHANTFLO` | Does **not** execute them | Pre-debit notice, compliant execution, retries, webhooks |
| A debit executed by both (a misroute) | Refunds the customer from its PSP account | Detects it, alerts the merchant within ⟨1 business day⟩, hands back debits it had not started |
| Customer complaints | First line, as today | Evidence from its records (timeline, PSP references) |
| Mandates, customer consent, pre-debit notice wording | Owns them | Sends notices for its debits as the merchant's processor |

Questions for counsel: who bears the cost of a double debit caused by each party's error; whether
the merchant's customer terms already cover a processor sending pre-debit notices.

## 3. Pass criteria and reporting

The pilot passes when, over the canary period: zero double debits; zero executions inside NPCI
restricted windows; ≥ 99.9% of webhooks delivered within 5 minutes; the monthly statement reconciles
to the PSP's settlement report. AutoPay uplift (canary vs control success rate, 95% interval) is
reported, not promised. Merchantflo gives the merchant the scorecard and the shadow report ("what
you would have saved") in the dashboard and as CSV.

Value statements are conservative by method: only technical failures inside NPCI restricted windows
count as certain value; other technical failures are an upper bound shown separately; failures of
unknown cause earn nothing. Neither party may publish pilot figures without the other's written
consent (Merchantflo would ask before any case study).

## 4. Data

Shadow debits and reported executions hold the mandate reference, amounts, times, outcomes and the
PSP's transaction id — no VPA or phone number. Retention and erasure follow the
[retention policy](retention-policy.md); the history export is used only for the backtest and
deleted with the merchant's other records at contract end. Merchantflo acts as the merchant's data
processor under the [DPA](dpa.md).

## 5. Fees, term and exit

- Pilot fee: ⟨none / fixed⟩ during the pilot; pricing from Phase 8 applies only after a signed order.
- Term: ⟨8–12 weeks⟩ or until FULL plus 2 weeks, whichever is later.
- Exit: either party, on ⟨7 days⟩' notice, or at once for a confirmed double debit or a
  restricted-window execution. On exit Merchantflo moves the merchant to SHADOW, pauses its debits,
  and hands back every debit it has not started (the merchant executes and reports them); nothing
  already accepted is silently dropped.
- Service levels during the pilot: best effort, with the incident process in
  [incident response](../runbooks/incident-response.md); no financial service credits.

## 6. Questions for counsel

1. Is a staged hand-over of AutoPay execution consistent with the merchant's PSP agreement and the
   mandate as the customer authorised it (same merchant, same PSP, same VPA)?
2. Liability split and caps for a double debit, a missed debit, and a debit executed in a restricted window.
3. Is consent needed from the merchant's customers for Merchantflo sending pre-debit notices in the
   merchant's name, or is the processor relationship enough?
4. Can Merchantflo keep anonymised, aggregated pilot figures after exit (no merchant name)?
