# External actions (founders only)

Things code cannot do. Several have weeks of lead time and sit on the critical path, so they start
in Phase 0. Update the status column as they move.

| # | Action | Owner | Needed by | Status |
|---|---|---|---|---|
| 1 | Ask Cashfree to activate **UPI AutoPay** on the sandbox and production accounts | Founder 3 | Phase 3 | To do |
| 2 | Ask Cashfree about the **partner/platform programme** (onboard merchants under us, settlement stays merchant-owned) | Founder 3 | Phase 2 | To do |
| 3 | Open **Razorpay** and **PayU** developer (test mode) accounts; store keys in a password manager, never in git | Founder 3 | Phase 3 | To do |
| 4 | Engage **payments counsel** (see questions below) | Founder 2 | Phase 6 | To do |
| 5 | **Design partners**: 5–8 conversations with OTT / SaaS / EdTech / insurance businesses running UPI AutoPay at volume; aim for 1–2 letters of intent | All | Phase 7 | To do |
| 6 | Company basics: entity, current account, GST registration, AWS account (billing in INR), domain | Founder 1 | Phase 5 | To do |
| 7 | GitHub settings: protect `main` (PRs + `CI` check required), enable secret scanning and Dependabot | Repo owner | Now | To do |
| 8 | Watch for NPCI's confirmed **MDR start date**, then set `MDR_EFFECTIVE_FROM` | Founder 2 | Ongoing | Watching |
| 9 | Obtain the NPCI circular texts for the AutoPay peak windows (exact evening start) and OC-163/163A portability | Founder 2 | Phase 1 | To do |
| 10 | Run the sandbox smoke tests with real test keys and record response shapes: `npm run smoke:cashfree` (with `SMOKE_CHANNELS=1`, `SMOKE_RECON_DAY`) and `npm run smoke:razorpay` | Founder 3 | Phase 3 exit | To do |
| 11 | Ask Razorpay to enable S2S UPI on test and live accounts; set automatic capture | Founder 3 | Phase 3 exit | To do |

## Message templates

**1. Cashfree — UPI AutoPay activation**

> Subject: Enable UPI AutoPay (subscriptions, controlled notify/execute) — sandbox and production
>
> Hi team, we're integrating UPI AutoPay using the Subscriptions API with the controlled flow
> (`/subscriptions/pay/controlled/notify-mandate` and `execute-mandate`, API version 2026-01-01).
> In sandbox, subscriptions stay `INITIALIZED` after authorisation with `testsuccess@gocash`, which
> your FAQ says means AutoPay isn't enabled on the account. Please enable UPI AutoPay for our sandbox
> (App ID: <id>) and production account, and confirm: (a) the full list of `execution_status` /
> `payment_status` values for controlled executions; (b) whether failed-payment auto-refunds appear in
> `GET /orders/{id}/refunds`; (c) whether UPI collect, intent and QR are enabled for our production MID.

**4. Counsel — questions**

1. With merchants using their own PSP accounts and Merchantflo never holding funds, are we a technology
   service provider outside the RBI Payment Aggregator framework? What must our contracts say?
2. Is offering a discount for choosing a non-UPI method (never a surcharge on UPI) compatible with
   NPCI's rule that MDR may not be passed to customers?
3. Marketplace carts split by vendor ownership (each vendor merchant of record): any issue? We never
   split one merchant's payment to stay under ₹2,000.
4. DPDP Act 2023: are we a data processor for merchants? Required notices, retention limits, breach duties.
5. Data localisation: confirm AWS Mumbai with India-only backups satisfies RBI's payment data storage rules.
