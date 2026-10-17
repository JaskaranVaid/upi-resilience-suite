# 0008 — Pilots roll out by mandate, and intake decides who executes each debit

Date: 2026-10-16 · Status: Accepted

## Context
A pilot merchant already runs UPI AutoPay through its own billing system and PSP account. Phase 7
has to move its real debits onto Merchantflo without betting its collections on day one: first
show, on its own traffic, what Merchantflo would have done; then execute a slice; then everything.
Every step must be reversible at once, and no debit may ever be executed by both paths. The
uplift claim has to survive a sceptical finance team, so the comparison must be fair.

## Decision
- **A rollout stage per merchant**: `SHADOW` (the merchant's system executes; Merchantflo only
  plans), `CANARY p%` (Merchantflo executes the mandates in buckets below `p`), `FULL` (default for
  every merchant not in a pilot). Operators change it in the ops console, with a reason; every
  change is history, audit and a `pilot.stage_changed` webhook.
- **Canary assignment is by mandate**: bucket = first 32 bits of SHA-256(mandate id) mod 100.
  Raising the percentage only adds mandates, lowering it only removes them, and assignment is random
  with respect to customers — so canary vs control is a randomised comparison in the same weeks.
  Per-PSP or per-amount canaries were rejected: they give no fair control group.
- **Intake decides the executor, once, and says so.** The merchant keeps one integration
  (`POST /v1/mandates/:id/debits`); the response is a Debit (`executedBy: MERCHANTFLO`) or a
  ShadowDebit (`executedBy: MERCHANT`). The decision is stored and replayed for the same
  idempotency key, across stage changes.
- **Shadow debits live in their own table**, which the worker, router and notice code never read:
  a structural guarantee that a shadow debit cannot reach a PSP, rather than a state that every
  money-moving query must remember to exclude.
- **One key, one debit across both tables**: both inserts take `pg_advisory_xact_lock` on
  (merchant, key) and re-check the other table.
- **Live money starts in shadow**: a merchant's first switch to LIVE mode (with no rollout history)
  puts it in `SHADOW`.
- **A misrouted report hands back** a still-`SCHEDULED` Merchantflo debit atomically (FAILED,
  `EXECUTED_BY_MERCHANT`, `debit.failed`). One already executing cannot be undone; the double-debit
  detector flags the pair.
- **Gates, not automation**: forward moves need a webhook URL, an active production connection when
  live, and no unreviewed double-debit suspect; FULL also needs ≥ 7 days and ≥ 30 final canary
  debits with the scorecard's gated criteria passing. An OWNER may override, and the override records
  which gates it overrode. Rollback is never gated.

## Consequences
- Merchants outside a pilot see no change: stage FULL, every debit `executedBy: MERCHANTFLO`.
- A rollback affects new requests only. Debits already accepted as Merchantflo's still run unless an
  operator pauses the merchant and the merchant takes them back ([pilot runbook](../runbooks/pilot.md#rollback)).
- If the live path loses the advisory-lock race after sending its notice, the customer gets a notice
  for a debit that is then not executed by us — harmless, logged, and practically never seen.
- Value claims stay conservative: only technical failures inside NPCI restricted windows are
  certain; other technical failures are an upper bound shown separately; unknown causes earn nothing.
- Daily mandates with equal amounts can produce false double-debit suspects, which operators dismiss.
