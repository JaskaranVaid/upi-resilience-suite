# Merchantflo roadmap: from demo to working model

**Working model (M2)** = a real pilot merchant runs real UPI AutoPay debits and checkout payments
through Merchantflo on *their own* PSP account, on a deployed and monitored system in India, with
correct webhooks, a dashboard their support team uses, and a monthly value statement that reconciles
to their PSP settlement report.

| Milestone | Meaning | Reached at |
|---|---|---|
| M0 Demo | Everything works against mock PSPs | Done (Phases 1–4 of the original build) |
| M1 Sandbox-complete | All flows on real PSP sandboxes, deployed to staging, merchant-usable in test mode | End of Phase 5 |
| M2 Pilot live | Real money, one merchant, ramped to 100% | End of Phase 7 |
| M3 Commercial | Pricing, billing, self-serve signup | End of Phase 8 |

Phases run in order. Each has an implementation plan in `docs/superpowers/plans/` and ends when its
exit criteria hold. External actions that only a founder can take are tracked in
[roadmap/external-actions.md](roadmap/external-actions.md).

## Phase 0 — Ground truth and unblockers ✅ (2026-10-15; founder actions open)
Regulatory fact sheet ([regulatory/fact-sheet.md](regulatory/fact-sheet.md)); decision records
([decisions/](decisions/)); MDR start date as configuration; CI; repo hygiene; Merchantflo naming;
external requests filed (Cashfree AutoPay activation, Razorpay/PayU sandboxes, counsel, design partners).
**Exit:** fact sheet and decisions committed, CI green, external requests listed with owners.

## Phase 1 — Correctness hardening ✅ (2026-10-15)
Slot-picking divide-by-zero; status check before mandate failover; MDR savings booked only on a
confirmed steered payment; AutoPay no-AFA limit enforced at intake; webhook events for reversals,
late captures, needs-action cases, notices and reschedules; bounded-concurrency status poller;
API and login rate limits; SSRF-safe webhook URLs; deferred-notice timing fix; Windows test-worker
memory fix. (`sk_test_`/`sk_live_` keys moved to Phase 2, where test and live modes exist.)
**Exit:** every fix covered by tests; no known correctness issue open.

## Phase 2 — Multi-tenant core ✅ (2026-10-15)
Per-merchant PSP connections with encrypted credentials; per-connection adapters, routing, health and
inbound webhooks; test vs live mode by API key (`sk_test_` / `sk_live_`); API key management (multiple keys, rotate, revoke);
merchant settings API; bulk mandate import.
**Exit:** two merchants on separate sandbox accounts run side by side, fully isolated.

## Phase 3 — Real payment rails ✅ code (2026-10-15; sandbox verification is founder action #10)
Cashfree completion (AutoPay end to end once activated, UPI intent + QR, netbanking/card through the
order); Razorpay adapter; settlement reconciliation (captured vs settled, mismatches open cases).
**Exit:** all flows complete in sandboxes; failover between two real sandboxes; recon matches 100%.

## Phase 4 — Checkout and integration kit ✅ code (2026-10-15; exit test with an outside developer open)
Checkout session API (quote + payment, savings booked on success); drop-in `checkout.js`;
OpenAPI spec and docs; typed Node SDK and webhook verification helpers; test-mode scenarios
(magic amounts ₹x.51–x.57 instead of magic VPAs, so AutoPay debits get them too); webhook delivery
log and redelivery; [integration guide](integration-guide.md).
**Exit:** a developer who did not build it integrates in test mode in under a day from the docs.

## Phase 5 — Production infrastructure ✅ code (2026-10-15; staging soak and drills are founder actions #13–#19)
Docker images; Terraform for AWS Mumbai (ECS, RDS, Secrets/KMS, ALB+WAF); dev/staging/prod with a
migration-aware deploy pipeline; logs, metrics, alerts (zero restricted-window executions, notice
failures, poller backlog, dead webhooks, PSP circuits); load tests; backup restore drill; runbooks.
Built: one image with api/worker/migrate roles and `/healthz`/`/readyz`, graceful drain, worker
heartbeat; migrations once per deploy under an advisory lock with an expand/contract check
([0007](decisions/0007-expand-contract-migrations.md)); JSON logs and an `ops.metrics` line driving
CloudWatch alarms; Terraform in [`infra/`](../infra/README.md); deploy workflow; load test, restore
and alarm drills; runbooks ([deploy](runbooks/deploy.md), [alerts](runbooks/alerts.md),
[backup-restore](runbooks/backup-restore.md), [load testing](runbooks/load-testing.md)).
**Exit:** 7-day staging soak with zero restricted-window executions; alerts fire-drilled. → **M1**

## Phase 6 — Security, compliance, internal operations ✅ code (2026-10-16; pen test, counsel review and drills are founder actions #20–#24)
Threat model, dependency/secret scanning, admin 2FA, external pen test; DPDP (retention, deletion,
privacy notice, DPA), field encryption for VPAs/phones; legal documents and counsel opinion;
internal ops console with a kill switch (pause executions per merchant, PSP or globally).
Built: CI gates (`npm audit`, CodeQL, gitleaks, Trivy) and security headers; ops console at `/ops/`
with operator accounts that always need a TOTP code, roles and an audit log; kill switch (global,
merchant, PSP — nothing cancelled, alarm after 30 minutes); optional two-factor sign-in for dashboard
users; VPAs, phones, payment actions and webhook payloads sealed at rest with a backfill; daily
retention purge and `POST /v1/privacy/erasure`; [threat model](security/threat-model.md),
[pen-test scope](security/pentest-scope.md), legal drafts in [legal/](legal/retention-policy.md),
runbooks ([kill switch](runbooks/kill-switch.md), [incident response](runbooks/incident-response.md),
[operators](runbooks/operators.md)).
**Exit:** no open high pen-test findings; kill switch tested.

## Phase 7 — Pilot ✅ code (2026-10-16; the agreement, history export, reviews, rollback drill and second partner are founder actions #25–#30)
Shadow mode (plan, never execute; "what you would have saved" report) → live canary (5–10% of
mandates) → 100% → second design partner. Pass: zero double debits, zero restricted-window executions,
measurable AutoPay uplift, ≥ 99.9% webhooks delivered within 5 min, statement reconciles to settlement.
Built: a rollout stage per merchant (SHADOW / CANARY p% / FULL; a first switch to live starts in
SHADOW) with canary assignment by mandate hash; debit intake that decides and states who executes each
debit (`executedBy`), shadow debits in their own table that nothing executes, one idempotency key →
one debit across both; execution reports and backtests (`POST /v1/pilot/executions`, JSON or CSV)
with automatic hand-back of misrouted debits; a conservative shadow report (certain vs potential);
a double-debit detector with an ops review queue and a critical alarm; a scorecard of the five
criteria (canary vs control uplift with a Newcombe 95% interval) that gates FULL, with recorded owner
overrides; ops console Pilots and Duplicates views; the dashboard Pilot tab; OpenAPI and SDK
([ADR 0008](decisions/0008-pilot-rollout-by-mandate.md), [pilot runbook](runbooks/pilot.md),
[pilot terms draft](legal/pilot-terms.md)).
**Exit:** one design partner at FULL with every gated criterion passing; a second partner in shadow or later.
→ **M2 (working model)**

## Phase 8 — Commercial launch
Pricing; billing from the value ledger with GST invoices; self-serve signup (test mode instant, live
after review); public docs and case study; support process. → **M3**
Billing counts verified value only: steering savings on payments Merchantflo processed (savings a
merchant reports through `POST /v1/checkout/quotes/:id/paid` for its own payments are shown, never
billed), and peak-hour rescues only for debits meant to run when requested
([ADR 0009](decisions/0009-engine-a-notice-timing.md)).

## Phase 9 — Scale and expansion (demand-driven)
More PSPs (PayU, the founding brief's third aggregator); bank-handle-aware routing; live push
(SSE/websockets); warehouse; marketplace payouts (today `POST /v1/checkout/split` only estimates; MDR
falls on the customer's payment, so savings need one payment per vendor); AutoPay failover across
PSPs once mandates are portable (NPCI OC-163/163A, founder action #9); multi-region; SOC 2. Parked:
offline UPI Lite X and CBDC.
