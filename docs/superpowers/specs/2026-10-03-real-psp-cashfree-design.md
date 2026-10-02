# Real PSP Integration — Cashfree: Design

Date: 2026-10-03 · Status: **self-approved** (owner delegated design decisions; rationale recorded here)
Builds on: Phases 1–4 + router fix (commit `ae79a05`).

## 1. Choice of PSP

| Need (our adapter contract) | Cashfree (API v2026-01-01) | Razorpay |
|---|---|---|
| We send the pre-debit notice, then debit when *we* choose (Engine A's core) | ✅ Controlled flow: `notify-mandate` → `execute-mandate` | ❌ built-in scheduler sends notices and debits |
| UPI collect, status, bank reference (RRN/UTR) | ✅ Orders + Order Pay (`upi.channel=collect`), `GET /orders/{id}/payments` (`bank_reference`) | ✅ |
| Signal that a failed payment had debited the customer | ✅ auto-refunds (`refund_type: PAYMENT_AUTO_REFUND`) via `GET /orders/{id}/refunds` | n/a for this decision |
| Merchant-initiated UDIR complaint | ❌ not offered (disputes are customer-raised; merchant can only read/accept/contest) | ❌ not found |

**Decision: Cashfree.** Only provider whose UPI AutoPay API leaves timing control with us.

Sources (fetched 2026-10-03): Cashfree API reference — create/fetch controlled notification &
execution, fetch subscription payment, create order, order pay, get payments for an order, get all
refunds for an order, refund webhooks, payment webhooks, subscription webhooks, webhook signature
verification (`cashfree.com/docs/api-reference/payments/latest/...`).

## 2. Facts from the docs that change our design

1. **25-hour minimum** between a successful pre-debit notice and execution (sandbox and production).
   Our scheduler allowed 24 h + 30 min → every Cashfree execution would be rejected.
2. **Notice date window**: `payment_schedule_date` must be T+1 … T+7 from the notification.
   We always notified at intake → a debit due in 20 days could not be notified.
3. **Amount match**: execution amount must equal the notified amount (ours is fixed per debit ✓).
4. **One base `payment_id` per debit**, many `notification_id`s / `execution_id`s; limits on
   notifications/executions per payment (`payment_*_restriction_error`).
5. **No merchant UDIR complaint API.**
6. **Execution/payment status enums are not fully documented** (subscription webhooks show
   `SUCCESS, FAILED, CANCELLED, INITIALIZED, PENDING`; PG payments `SUCCESS, FAILED, PENDING,
   NOT_ATTEMPTED, USER_DROPPED, VOID, CANCELLED`).
7. **Webhook signature**: `x-webhook-signature = base64(HMAC_SHA256(clientSecret, x-webhook-timestamp + rawBody))`.
8. **Create Order requires `customer_details.customer_phone`** (10 digits) and alphanumeric `customer_id`.
9. **Idempotency**: `x-idempotency-key` header on POSTs; replays flagged `x-idempotency-replayed`.

## 3. Decisions (self-approved)

**D1 — Adapter contract v2 (provider capabilities + transaction context).**
```ts
interface PspCapabilities {
  minNoticeMs: number;              // Cashfree 25 h; mock 0 (rules decide)
  maxNoticeLeadMs: number | null;   // Cashfree 6 days (T+7 window, one day margin); mock null
  udirComplaints: boolean;          // Cashfree false; mock true
  portableMandates: boolean;        // mandate usable via other PSPs (MIC); Cashfree false; mock true
  collectRequires: Array<'customerPhone'>;
}
type TxnContext = { kind: 'COLLECT' } | { kind: 'MANDATE'; mandateRef: string; noticeRef: string };
status(txnRef, ctx); inquire(txnRef, ctx);
executeMandate({ txnRef, mandateRef, amountPaise, noticeRef });
collect({ txnRef, payerVpa, amountPaise, customerPhone? });
mode: 'MOCK' | 'SANDBOX' | 'LIVE';
verifyWebhook?(rawBody, headers, now): { ok: true; refs: string[] } | { ok: false; reason };
```
Rationale: Cashfree needs the mandate (`subscription_id`) and base payment (`payment_id`) to look up
an execution; passing them explicitly beats parsing references out of strings.

**D2 — Scheduler honours the provider's notice window.** Minimum notice =
max(rule `preDebitNoticeHours`, provider `minNoticeMs`) + buffer. If the slot is further than
`maxNoticeLeadMs` away, the notice is **deferred**: the debit is stored `SCHEDULED` with
`notice_date = NULL` and `scheduled_at` = an off-peak time 6 days before the due date; when the worker
reaches it, it sends the notice and schedules the execution (existing re-notice path). Migration makes
`debits.notice_date`/`notice_sent_at` nullable. Mock PSPs: unchanged behaviour.

**D3 — Mandate portability.** A mandate whose `eligiblePsps` contains a non-portable PSP must list
only that PSP (400 otherwise). If `eligiblePsps` is omitted, it defaults to all *portable* PSPs; if
none are portable the request must specify one. Cashfree mandate `mandateRef` = Cashfree `subscription_id`
(mandate registration itself — customer authorisation — stays in Cashfree; out of scope).

**D4 — Status mapping is conservative.** Unknown/undocumented statuses map to `PENDING` (never
retried, keeps being checked). Execution/collect transport outcomes:
| Situation | Result |
|---|---|
| network error / client timeout | `TECHNICAL_DECLINE/TIMEOUT` (router status-checks before any retry) |
| 5xx, 429, 401/403 (misconfig, logged) | `TECHNICAL_DECLINE/PSP_ERROR` |
| 400 `Prev_Execution_In_Progress` | `PENDING` |
| 400 `payment_execution_restriction_error` "max executions" | `BUSINESS_DECLINE/LIMIT_EXCEEDED` (stop) |
| 400 "No successful notification" | `TECHNICAL_DECLINE/PSP_ERROR` (retried within budget) |
| other 400 on a debit/collect | `BUSINESS_DECLINE/OTHER` (request rejected; retrying cannot help) |
| 404 on status/inquiry | `NOT_FOUND` |
| failure reason mentions insufficient funds / revoked / paused / expired / limit | `BUSINESS_DECLINE` (mapped code) |
| other `FAILED` | `TECHNICAL_DECLINE/PSP_ERROR` for routing; debit UNKNOWN for tracking |

**D5 — Inquiry & reversals (collect).** `GET /orders/{id}/payments` + `GET /orders/{id}/refunds`.
`SUCCESS` → debited + captured, `bank_reference` → RRN. `USER_DROPPED / NOT_ATTEMPTED / VOID /
CANCELLED` or `FAILED` with `error_source = customer` → not debited. Other `FAILED` → debit
UNKNOWN unless an auto-refund (`PAYMENT_AUTO_REFUND` / `UNRECONCILED_AUTO_REFUND`) exists →
debited, reversal `INITIATED` (pending states) or `COMPLETED` (`SUCCESS`, `processed_at`).
Merchant-initiated refunds are ignored (Phase 3 scope). **AutoPay** inquiry uses the controlled
execution; subscription reversals are not exposed by API → UNKNOWN (watched, then manual).

**D6 — UDIR complaints are a capability.** Cashfree adapter reports `udirComplaints: false`;
`raiseComplaint` returns a non-retryable "not supported" result. Complaint eligibility adds
"the payment provider doesn't support merchant-raised UDIR complaints — the customer raises it from
their UPI app"; the dashboard hides the button and shows that reason.

**D7 — Webhooks accelerate, never decide.** `POST /webhooks/psp/:pspId` verifies the signature
(raw body, timing-safe compare, ±5 min timestamp window), extracts references (order_id,
execution_id, payment_id), and **only** schedules an immediate status check (tracking `next_check_at = now`;
`PENDING_CONFIRMATION` debits `scheduled_at = now`). State changes still come from our own API
lookups through the lease-guarded paths. Unmatched/irrelevant events → 200 (no retry storms).

**D8 — Idempotency & safety.** Every Cashfree POST carries a deterministic `x-idempotency-key`
derived from our reference (same txnRef ⇒ same key ⇒ replay, never a second debit). Amounts are
sent in rupees with 2 decimals and parsed back to paise with rounding. Secrets come from env only,
are never logged, and requests have a client-side timeout (default 10 s).

**D9 — Configuration.** `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_ENV=sandbox|production`
(default sandbox), `CASHFREE_TIMEOUT_MS`. Adapter id `cashfree`, mode `SANDBOX`/`LIVE`. `MOCK_PSPS`
can be set empty to run Cashfree only. Production with mock adapters keeps the existing warning.

**D10 — Testing without credentials.** Contract tests run the adapter against an in-process fake
Cashfree (records requests, replays documented responses). A `scripts/cashfree-sandbox-smoke.ts`
exercises the real sandbox **only** when the owner supplies sandbox credentials; it never runs in CI.

## 4. Unverified assumptions — confirm in sandbox before production

1. Exact `execution_status` / `payment_status` strings for controlled executions (mapped defensively).
2. Whether UPI collect `orders/sessions` requires the `x-client-*` device headers server-side (we send
   documented values; configurable).
3. Whether auto-refunds for failed payments appear in `GET /orders/{id}/refunds` (the RefundEntity
   schema lists `PAYMENT_AUTO_REFUND`, the docs don't state it explicitly; the auto-refund webhook
   also triggers a recheck either way).
4. NPCI's restrictions on UPI collect for P2M may limit availability; Cashfree still documents it.
5. Webhook timestamp unit (example is milliseconds; both units accepted).

## 5. Out of scope
Mandate registration UI/flow, merchant-initiated refunds, Cashfree disputes ingestion, multi-region,
shared (Redis) health state.
