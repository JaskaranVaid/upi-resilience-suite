# Phase 3 — Real Payment Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real checkout flows (UPI intent, UPI QR, netbanking/cards via the PSP's hosted checkout) on Cashfree and Razorpay, and daily settlement reconciliation that turns "captured" into "settled".

**Architecture:** A payment carries a `channel`. Adapters declare the channels they support and return a *customer action* with a pending result (deeplinks, QR data, redirect URL, or PSP-SDK parameters); the router only tries PSPs that support the channel; the action is stored on the payment so idempotent replays return it. A second real adapter (Razorpay) plugs in as a connection provider. Settlement reports are pulled per connection per day into `settlements`, matched to payments/debits, and recorded as settlement facts on `payment_tracking`; mismatches and long-unsettled captures open cases.

**Tech Stack:** existing. Sources: Cashfree Order Pay (`/orders/sessions`, UPI `link`/`qrcode`, netbanking `link`) and Settlement Reconciliation (`POST /settlement/recon`) docs, API 2026-01-01; Razorpay Orders, S2S UPI (`/v1/payments/create/upi`, `flow: intent|collect`), Payments, Refunds and Settlement Recon (`GET /v1/settlements/recon/combined`) docs.

**Spec:** `docs/roadmap.md` Phase 3.

## Global Constraints
- No card data ever touches Merchantflo (no PCI scope): cards go through the PSP's own checkout (SDK parameters only).
- Intent/QR deeplinks are passed through unmodified (PSP guidance).
- Unknown PSP statuses stay PENDING (never retried); settlement data never changes payment state, only settlement facts and cases.
- Recon is idempotent per PSP event id; re-running a day changes nothing.
- Amounts: Razorpay subunits = paise; Cashfree rupees → paise with rounding.

## Review Focus
- An intent payment retried with the same idempotency key returns the same deeplink, never a second PSP order (Task 1/2 tests).
- A PSP that doesn't support the requested channel is never tried (Task 1 test).
- A Razorpay order is looked up by our reference before one is created, so a retried txnRef doesn't create a second order (Task 3 test).
- A settlement whose amount differs from the captured amount opens a case; the same report re-run creates no duplicates (Task 5 tests).
- A Razorpay connection can't be used for mandates (Task 4 test).

---

### Task 1: Channels and customer actions in the core
**Files:** `src/psp/types.ts` (`PaymentChannel`, `CustomerAction`, `capabilities.channels`, `CollectRequest.channel`, PENDING `action?`), `src/psp/mock.ts`, `src/routing/router.ts` (channel filter), `src/payments/service.ts`, `src/payments/outcome.ts`, `src/db/schema.ts` + migration (`payments.channel`, `payments.customer_action`, `payer_vpa` nullable), `src/api/schemas.ts`, `src/api/routes/payments.ts`; tests in `test/api/channels.test.ts`.
**Produces:** `PaymentChannel = 'UPI_COLLECT' | 'UPI_INTENT' | 'UPI_QR' | 'NETBANKING' | 'CARD'`; `CustomerAction = { type: 'UPI_INTENT'; url: string; appUrls: Record<string,string> } | { type: 'UPI_QR'; qrData: string } | { type: 'REDIRECT'; url: string } | { type: 'PSP_CHECKOUT'; provider: string; environment: string; params: Record<string,string> } | { type: 'UPI_COLLECT'; vpa: string }`.

### Task 2: Cashfree channels
**Files:** `src/psp/cashfree/adapter.ts`, `src/psp/cashfree/mapping.ts`; Test `test/psp/cashfree.test.ts`.
UPI_INTENT → order pay `upi.channel=link` → `data.payload` (`default`, app keys); UPI_QR → `qrcode` → `data.payload.qrData` (or base64 image); NETBANKING with bank code → `netbanking.channel=link` → REDIRECT `data.url`; NETBANKING without bank / CARD → PSP_CHECKOUT `{ paymentSessionId }` (Cashfree JS SDK).

### Task 3: Razorpay adapter and connection provider
**Files:** Create `src/psp/razorpay/{adapter,mapping,webhook}.ts`; Modify `src/psp/connections.ts`, `src/db/schema.ts` (`PspProvider` + 'razorpay'), `src/api/routes/connections.ts` (credentials `keyId`, `keySecret`, `webhookSecret`); Test `test/psp/razorpay.test.ts`.
Orders with `receipt` = txnRef (looked up first: `GET /v1/orders?receipt=`); UPI collect/intent via `POST /v1/payments/create/upi`; CARD/NETBANKING → PSP_CHECKOUT `{ keyId, orderId }`; status/inquiry via `GET /v1/orders/{id}/payments` (captured → SUCCESS, authorized → PENDING with customer debited, failed → decline by `error_source`/`error_reason`, refunded & not captured → reversal completed; `acquirer_data.rrn` → RRN); webhooks `X-Razorpay-Signature` = hex HMAC-SHA256(body, webhookSecret); `checkCredentials` via `GET /v1/orders?count=1`.

### Task 4: AutoPay capability
**Files:** `src/psp/types.ts` (`capabilities.autopay`), adapters, `src/mandates/eligibility.ts`; tests.
Mandates may only name PSPs with `autopay: true` (Cashfree, mock), never Razorpay.

### Task 5: Settlement reconciliation
**Files:** Create `src/settlements/{types,reconciler,service}.ts`; adapters `settlements(range)` (Cashfree `POST /settlement/recon` paginated by cursor; Razorpay `GET /v1/settlements/recon/combined` per day, `count`/`skip`); schema + migration (`settlements`, `recon_runs`, tracking `settled_at`, `settlement_utr`, `settlement_amount_paise`, `settlement_fee_paise`, case reasons `SETTLEMENT_MISMATCH`, `NOT_SETTLED`); worker schedule (daily per connection, previous IST day, + backfill); API `GET /v1/settlements?from&to`, dashboard money panel "Settled to your bank", statement reconciliation line.
- Tests: match by PSP payment id then by order reference; idempotent re-run; amount mismatch → case; captured and unsettled beyond `NOT_SETTLED_AFTER_DAYS` (3) → case; unmatched items reported, not dropped.

### Task 6: Docs
README (channels, Razorpay, settlements), runbook for Razorpay, roadmap.
