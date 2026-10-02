# Phase 3 — Status Polling & UDIR Investigation Console: Design

Date: 2026-10-02 · Status: **awaiting approval**
Builds on: `2026-10-02-upi-resilience-suite-design.md` (Phases 1–2, commit `b74e126`)
Decisions: the ten Phase 3 decisions supplied by the product owner (D1–D10 below).

---

## 1. Repository map vs decisions

| Decision | Existing foundation | Fit |
|---|---|---|
| D1 No refund due date; extension point | `src/config/rules.ts` versioned `RuleSet` | Add an empty, typed `reversalDeadlineRules` registry. No values. |
| D2 Bank auto-reversals only | No refund concept anywhere | New *reversal facts* on a tracking record; no refund state machine. `reversal` kept as a sub-object so a future `merchantRefunds` collection can sit beside it. |
| D3 Unified Collect + AutoPay view | Separate `payments` and `debits` tables + state machines | Read-model only: SQL view `merchant_payments_v` (UNION ALL) joined to a new `payment_tracking` table. Domain tables untouched except additive columns. |
| D4 "Merchant credited" = PSP-confirmed capture | `payments.state = SUCCEEDED`, `debits.state = SUCCEEDED` | Field named `capture` (`CAPTURED`/…); UI label **"Captured (PSP-confirmed)"** with explanatory tooltip "Not a bank-settlement confirmation". The word "settled" is never used. |
| D5 Polling schedule | Debits: worker re-checks `PENDING_CONFIRMATION` every 5 min for 48h. Payments: lazy refresh inside `GET` only | New `StatusPoller` for tracking records with config-driven schedule. See §9 conflict C1 for debits. |
| D6 Dashboard users + roles + cookie sessions | Merchant API key + admin token only | New `dashboard_users`, `dashboard_sessions`; scrypt (node:crypto); `@fastify/cookie`. |
| D7 Recheck / note / raise UDIR | Nothing | `DisputeService` + adapter methods `inquire`, `raiseComplaint`, `complaintStatus`; mock-backed with `mode: 'MOCK'`. |
| D8 Customer status token | Nothing | HMAC-derived token per payment; `GET /public/payments/:id/status`; reads canonical state only. |
| D9 Static HTML + vanilla JS at `/dashboard` | No frontend | `dashboard/` folder served by `@fastify/static`; native ES modules, no build. |
| D10 Collect failover | `Router.execute` fails over on any non-timeout technical decline without a status check (`src/routing/router.ts:89-94`) | Status-check-before-failover for `op: 'collect'` only. §8. |

### Infrastructure the decisions need that doesn't exist yet
- Cookie parsing/signing → `@fastify/cookie` (official plugin).
- Static file serving → `@fastify/static` (official plugin).
- Password hashing → `node:crypto` `scrypt` (no new dependency).
- CORS for the public customer-status route only → set headers on that route (no plugin).
- Audit/event log → new `payment_events` table.
- No Redis is introduced; leasing/claiming continues on Postgres `FOR UPDATE SKIP LOCKED`.

---

## 2. Architecture

```
 Customer checkout page          Merchant dashboard (/dashboard, static)       Merchant servers
        │ GET /public/…/status          │ cookie session                         │ API key
        ▼                               ▼                                        ▼
 ┌──────────────────────────── Fastify API ─────────────────────────────────────────────────┐
 │ public routes            /dashboard/api/* (session + role guard)        /v1/* (existing) │
 └──────┬───────────────────────────┬───────────────────────────────────────────┬──────────┘
        │                           │                                           │
        ▼                           ▼                                           ▼
  StatusPresenter ◄──── PaymentQueryService (unified read model)        PaymentService / SchedulerService
  (pure mapping)                    │                                     (Phase 1–2, + tracking hooks)
                                    ▼                                           │
                             DisputeService ───────────┐                        │
                                    │                  │                        │
                                    ▼                  ▼                        ▼
                         TrackingService  ◄──── StatusPoller (worker loop) ◄── starts watch
                         (apply inquiry,          claims due rows
                          reduce state,           with lease
                          open/close cases,             │
                          emit events)                  │
                                    │                   │
                                    └────────► PspRegistry → PspAdapter (inquire / raiseComplaint / complaintStatus)
                                                                   │
                                                              PSP / UDIR (mock today)
```

Rules that hold everywhere:
- The UI and the public endpoint only read canonical state produced by `TrackingService`. They never call PSPs.
- Every PSP call goes through `PspAdapter`. No `if (psp === …)` outside adapters.
- All state derivations (merchant status, customer status, case status) are **pure functions** in `src/tracking/derive.ts`, unit-tested, consumed by APIs. The frontend renders strings and enums it receives.

---

## 3. Domain model

### 3.1 What stays as-is
- `payments.state`: `PENDING → SUCCEEDED | FAILED` (Phase 2). Unchanged semantics: `FAILED` stays terminal.
- `debits.state`: Phase 1 machine unchanged.

### 3.2 New: `payment_tracking` (one row per payment of either type, once it has reached a PSP)

Orthogonal *facts* about money movement plus the *verification* lifecycle. Keeping them off the
domain tables means the existing state machines don't change.

| Column | Type | Meaning |
|---|---|---|
| `id` | text pk | `trk_…` |
| `merchant_id` | text | |
| `subject_type` | `'COLLECT' \| 'AUTOPAY'` | |
| `subject_id` | text | `payments.id` or `debits.id`; unique with subject_type |
| `psp_id`, `txn_ref` | text | the PSP + reference to inquire with |
| `upi_rrn` | text null | 12-digit UPI reference (the number customers see as "UPI Ref No"); indexed per merchant |
| `npci_txn_id` | text null | PSP/NPCI transaction id when provided |
| `customer_debit` | `UNKNOWN \| DEBITED \| NOT_DEBITED` | |
| `capture` | `UNKNOWN \| CAPTURED \| NOT_CAPTURED` | PSP-confirmed capture (D4) |
| `reversal_status` | `NONE \| INITIATED \| COMPLETED \| UNKNOWN` | bank auto-reversal (D2) |
| `reversal_initiated_at`, `reversal_completed_at` | timestamptz null | |
| `verification_status` | `NOT_REQUIRED \| IN_PROGRESS \| RESOLVED \| NEEDS_MANUAL_INVESTIGATION` | |
| `verification_started_at` | timestamptz null | budget clock starts here |
| `next_check_at` | timestamptz null | |
| `check_count` | int | |
| `last_checked_at` | timestamptz null | |
| `lease_until` | timestamptz null | concurrency guard (poller and manual recheck) |
| `created_at`, `updated_at` | timestamptz | |

Indexes: unique `(subject_type, subject_id)`; `(merchant_id, upi_rrn)`; `(verification_status, next_check_at)`.

### 3.3 New: `payment_cases` (the "dispute/issue")

Opened automatically by `TrackingService` when a deterministic trigger fires (§6.3), or when a
user raises a UDIR complaint on a payment that has no open case. At most one non-resolved case
per payment.

| Column | Meaning |
|---|---|
| `id` `cas_…`, `merchant_id`, `subject_type`, `subject_id`, `tracking_id` | |
| `reason` | `DEBITED_NOT_CAPTURED \| VERIFICATION_EXHAUSTED \| STATUS_MISMATCH \| MERCHANT_RAISED` |
| `status` | `NEEDS_ACTION \| INVESTIGATING \| VERIFICATION_PENDING \| REVERSAL_PENDING \| RESOLVED` (derived, persisted) |
| `resolution` | null \| `REVERSED_TO_CUSTOMER \| CAPTURED \| NOT_DEBITED \| COMPLAINT_RESOLVED \| CLOSED_BY_MERCHANT` |
| `opened_at`, `resolved_at`, `updated_at` | |

### 3.4 New: `udir_complaints`

| Column | Meaning |
|---|---|
| `id` `cmp_…`, `case_id`, `merchant_id`, `psp_id` | |
| `mode` | `MOCK \| LIVE` — copied from the adapter; UI shows MOCK prominently (D7) |
| `psp_complaint_ref` | reference returned by the PSP |
| `status` | `SUBMITTED \| IN_PROGRESS \| RESOLVED_REVERSED \| RESOLVED_NO_REVERSAL \| REJECTED` |
| `reason_code` | `DEBITED_NOT_CREDITED \| STATUS_UNKNOWN` (our normalized reasons) |
| `raised_by_user_id`, `raised_at`, `last_status_at` | |

### 3.5 New: `case_notes`
`id, case_id, merchant_id, author_user_id, body (≤ 4000 chars), created_at`. Append-only.

### 3.6 New: `payment_events` (audit + timeline + Phase 4 source)

Append-only. `id, merchant_id, subject_type, subject_id (nullable for user events), case_id null,
type, actor_type ('SYSTEM' | 'DASHBOARD_USER' | 'API_KEY'), actor_id null, data jsonb, created_at`.
Index `(subject_type, subject_id, created_at)`, `(merchant_id, created_at)`.

`data` may contain internal detail (PSP codes, check counts). **It is never returned to the UI
as-is**; the timeline API maps each `type` to a merchant-safe label + whitelisted fields.

Event types — only ones the architecture produces:

| Type | Emitted by | Merchant-safe label |
|---|---|---|
| `PAYMENT_CREATED` | PaymentService.create, worker (first execution of a debit) | Payment initiated |
| `PAYMENT_SUBMITTED` | after router outcome (data: psp, attempt summary) | Sent to payment provider |
| `PAYMENT_STATE_CHANGED` | settle paths, worker succeed/fail | Payment marked successful / failed |
| `VERIFICATION_STARTED` | TrackingService | Payment verification started |
| `STATUS_CHECKED` | poller / recheck (data: outcome kind, check #) | Status checked with provider (UI collapses repeats) |
| `RRN_RETRIEVED` | first time an RRN is learnt | UPI reference retrieved |
| `CUSTOMER_DEBIT_DETECTED` | debit fact changes to DEBITED | Customer account debited |
| `CAPTURE_CONFIRMED` | capture → CAPTURED | Payment captured (PSP-confirmed) |
| `REVERSAL_INITIATED` / `REVERSAL_COMPLETED` | reversal fact changes | Auto-reversal initiated / completed |
| `VERIFICATION_RESOLVED` / `VERIFICATION_EXHAUSTED` | TrackingService | Verification complete / needs manual investigation |
| `CASE_OPENED` / `CASE_STATUS_CHANGED` / `CASE_RESOLVED` | TrackingService | Issue opened / status changed / resolved |
| `UDIR_COMPLAINT_RAISED` / `UDIR_COMPLAINT_UPDATED` | DisputeService / poller | UDIR complaint raised / updated (with MOCK label) |
| `RECHECK_REQUESTED` | DisputeService (actor = user) | Recheck requested by {user} |
| `NOTE_ADDED` | DisputeService | Note added by {user} |
| `PAYMENT_VIEWED` / `CASE_VIEWED` | dashboard detail endpoints | (audit log only; not shown in timeline) |
| `USER_CREATED` / `USER_UPDATED` / `USER_DISABLED` / `LOGIN_SUCCEEDED` / `LOGIN_FAILED` | auth/user services | (audit log only) |

Phase 4 compatibility: amounts live on the subject; events carry `type` + timestamps, so
"revenue recovered via late capture", "reversals completed", "time-to-resolution" are all
computable by joining events to subjects. `savings_events` is unchanged.

### 3.7 Additive columns on existing tables
- `payments.order_id text null` (+ index `(merchant_id, order_id)`), optional in `POST /v1/payments`.
- `debits.order_id text null`, optional in `POST /v1/mandates/:id/debits`.
No existing column changes meaning. Existing rows have no `payment_tracking` row; read model
uses LEFT JOIN and shows facts as `UNKNOWN`/derived from state.

### 3.8 Rules extension point (D1)
```ts
// src/config/rules.ts
export interface ReversalDeadlineRule {
  failureCategory: string;   // must map to a documented UPI failure category
  source: string;            // citation of the circular, required
  dueBy(debitedAt: Date): Date;
}
export const REVERSAL_DEADLINE_RULES: readonly ReversalDeadlineRule[] = []; // intentionally empty
```
Nothing reads it to produce UI output in Phase 3. No "overdue" category is computed.

---

## 4. PSP adapter contract (additions)

Existing methods are unchanged. Additions:

```ts
interface PspAdapter {
  readonly id: string;
  readonly mode: 'MOCK' | 'LIVE';                        // new
  // existing: sendPreDebitNotice, executeMandate, collect, status
  inquire(txnRef: string): Promise<TransactionInquiry>;  // new
  raiseComplaint(req: ComplaintRequest): Promise<ComplaintResult>;  // new
  complaintStatus(pspComplaintRef: string): Promise<ComplaintStatusResult>; // new
}

type TransactionInquiry =
  | { found: false }
  | {
      found: true;
      outcome: 'SUCCESS' | 'PENDING' | 'FAILED';
      customerDebit: 'DEBITED' | 'NOT_DEBITED' | 'UNKNOWN';
      capture: 'CAPTURED' | 'NOT_CAPTURED' | 'UNKNOWN';
      reversal: { status: 'NONE' | 'INITIATED' | 'COMPLETED' | 'UNKNOWN'; initiatedAt?: Date; completedAt?: Date };
      upiRrn?: string;        // 12 digits
      npciTxnId?: string;
      failureCode?: string;   // internal only, never surfaced
    };

interface ComplaintRequest { txnRef: string; upiRrn?: string; amountPaise: number; reason: 'DEBITED_NOT_CREDITED' | 'STATUS_UNKNOWN'; idempotencyKey: string }
type ComplaintResult = { ok: true; pspComplaintRef: string; status: ComplaintStatus } | { ok: false; reason: string; retryable: boolean };
type ComplaintStatusResult = { ok: true; status: ComplaintStatus; updatedAt: Date } | { ok: false; reason: string };
type ComplaintStatus = 'SUBMITTED' | 'IN_PROGRESS' | 'RESOLVED_REVERSED' | 'RESOLVED_NO_REVERSAL' | 'REJECTED';
```

`PspResult` `SUCCESS` gains optional `upiRrn?` (additive). `inquire` throwing = transient
failure (counts as a check, schedule continues).

**MockPsp**: deterministic. RRN = 12 digits derived from a hash of `txnRef`. Scriptable inquiry
outcomes (e.g. "debited-not-captured, reversal initiated after N checks"). Complaints get refs
`MOCK-UDIR-…` and advance status deterministically on each `complaintStatus` call per a script.
`mode = 'MOCK'`. `main.ts` logs a warning when `NODE_ENV=production` and any adapter is MOCK.

`PspRegistry` (new, tiny): `get(id)`, `ids()` — extracted so `TrackingService`/`DisputeService`
don't depend on `Router`. Router keeps its own map (no change).

---

## 5. Status taxonomy (pure functions, `src/tracking/derive.ts`)

Inputs: subject (state, type, createdAt) + tracking row (may be null) + open case (may be null).

### 5.1 Merchant status (dashboard, `/v1` additive field)
| `merchantStatus` | Condition (first match wins) | Label |
|---|---|---|
| `NEEDS_INVESTIGATION` | verification `NEEDS_MANUAL_INVESTIGATION` | Needs manual investigation |
| `REVERSED` | reversal `COMPLETED` | Reversed to customer |
| `REVERSAL_IN_PROGRESS` | reversal `INITIATED` | Auto-reversal in progress |
| `DEBITED_NOT_CAPTURED` | customer_debit `DEBITED` ∧ capture ≠ `CAPTURED` ∧ outcome ≠ pending | Customer debited, payment not captured |
| `SUCCEEDED` | state SUCCEEDED | Successful (captured) |
| `VERIFYING` | (state pending ∧ age ≥ `verifyingAfterMs` (45 s, config)) ∨ (state FAILED ∧ verification IN_PROGRESS ∧ customer_debit UNKNOWN) | Payment verification in progress |
| `PROCESSING` | state pending (incl. debit SCHEDULED/EXECUTING/PENDING_CONFIRMATION) | Processing |
| `FAILED` | state FAILED | Failed |

AutoPay `SCHEDULED` additionally carries `scheduledAt` (so the list can say "Scheduled for …").

### 5.2 Customer-safe status (public endpoint; collects only)
| merchantStatus | customer `status` | message |
|---|---|---|
| PROCESSING | `processing` | "Processing your payment…" |
| VERIFYING, NEEDS_INVESTIGATION, DEBITED_NOT_CAPTURED | `verification_in_progress` | "We're verifying your payment. Please don't make another payment." |
| REVERSAL_IN_PROGRESS | `refund_processing` | "Your bank is reversing this payment to your account." |
| REVERSED | `refunded` | "The amount has been reversed to your account." |
| SUCCEEDED | `success` | "Payment successful." |
| FAILED | `failed` | "Payment failed. You have not been charged." if `NOT_DEBITED`; otherwise "Payment failed." (A failed payment still under debit verification is `VERIFYING`, so the customer is told not to pay again until we know.) |

`DEBITED_NOT_CAPTURED` maps to `verification_in_progress` (not `refund_processing`) until the PSP
reports a reversal — we never promise a refund we haven't observed.

### 5.3 Case status (persisted on change; Dispute Desk filters)
| status | Condition (first match) |
|---|---|
| `RESOLVED` | reversal COMPLETED, or capture CAPTURED with no mismatch, or customer NOT_DEBITED, or complaint RESOLVED_* |
| `NEEDS_ACTION` | verification exhausted; complaint REJECTED; STATUS_MISMATCH open; DEBITED_NOT_CAPTURED with no reversal and verification no longer IN_PROGRESS |
| `INVESTIGATING` | a UDIR complaint is SUBMITTED / IN_PROGRESS |
| `REVERSAL_PENDING` | DEBITED_NOT_CAPTURED (reversal NONE/INITIATED) and verification IN_PROGRESS |
| `VERIFICATION_PENDING` | outcome still pending and verification IN_PROGRESS |

No "refund overdue" (D1): without a confirmed rule, "needs action" is driven only by the
configurable verification budget, not a regulatory clock.

---

## 6. Tracking & polling lifecycle

### 6.1 When a watch starts (`verification_status → IN_PROGRESS`)
- **Collect**: router outcome `PENDING`, or `FAILED` via `TECHNICAL_DECLINE` (customer may still have
  been debited — the core Phase 3 case). Business declines: tracking row created with
  `NOT_REQUIRED`.
- **AutoPay**: final `FAILED` with a technical code (attempts exhausted) → watch.
  `FAILED/UNRESOLVED_PENDING` (worker already spent 48h) → straight to `NEEDS_MANUAL_INVESTIGATION`.
  `PENDING_CONFIRMATION` stays worker-owned (see C1).
- Successful outcomes: tracking row created with `capture = CAPTURED`, `customer_debit = DEBITED`,
  `NOT_REQUIRED` (so search-by-RRN works for every payment).

### 6.2 Schedule (`src/config/polling.ts`, all overridable)
```ts
export interface PollingConfig {
  initialOffsetsMs: number[];      // [5_000, 15_000, 30_000, 45_000] from verification start
  fastIntervalMs: number;          // 60_000
  fastPhaseUntilMs: number;        // 15 * 60_000
  slowIntervalMs: number;          // 15 * 60_000
  maxDurationMs: number;           // 48 * 3_600_000 → NEEDS_MANUAL_INVESTIGATION
  maxChecks: number | null;        // null = bounded by duration only
  leaseMs: number;                 // 30_000
  verifyingAfterMs: number;        // 45_000 (merchant/customer wording switch)
  manualRecheckCooldownMs: number; // 10_000
  batchSize: number;               // 50
}
```
`nextCheckAt(startedAt, checkCount, cfg): Date | null` — pure; `null` = budget exhausted.

### 6.3 One check (`TrackingService.check(trackingId, actor)`)
1. **Claim**: `UPDATE … SET lease_until = now+leaseMs WHERE id = ? AND (lease_until IS NULL OR lease_until < now) RETURNING` (poller claims in batches with `FOR UPDATE SKIP LOCKED`). Not claimed → skip (poller) or `409 CHECK_IN_PROGRESS` (manual).
2. `inquiry = adapter.inquire(txnRef)` (+ `complaintStatus` if an open complaint exists).
3. `reduce(tracking, inquiry, subject, now, cfg)` — **pure** — returns new facts, verification status, `nextCheckAt`, events, case action (`open(reason) | update | resolve(resolution) | none`), and a domain outcome to apply (`collect: PENDING→SUCCEEDED|FAILED` only).
4. One transaction: update tracking (clear lease), apply domain outcome through the **existing** `PaymentService.settle` path (keeps Phase 2 webhooks + `TD_RECOVERED` savings), insert events, upsert case.

Terminal (stop polling, `RESOLVED`): captured; or outcome FAILED ∧ NOT_DEBITED; or reversal COMPLETED; or an open complaint resolved.
Exhausted (`NEEDS_MANUAL_INVESTIGATION`): `nextCheckAt` returns null while not terminal.

Case triggers (deterministic):
- `DEBITED_NOT_CAPTURED`: customer_debit DEBITED ∧ capture ≠ CAPTURED ∧ outcome FAILED.
- `VERIFICATION_EXHAUSTED`: budget exhausted.
- `STATUS_MISMATCH`: our state is FAILED but inquiry says SUCCESS/CAPTURED (a *late capture*). **We do not flip `FAILED → SUCCEEDED`** (preserves Phase 2 terminal semantics and webhook contract); the case tells the merchant the PSP captured the money after the failure was reported.
- `MERCHANT_RAISED`: complaint raised on a payment with no open case.

### 6.4 State transitions — tracking
```
NOT_REQUIRED ──(manual raise complaint)──────────────────────────► IN_PROGRESS
IN_PROGRESS ──(terminal facts)──► RESOLVED
IN_PROGRESS ──(budget exhausted)──► NEEDS_MANUAL_INVESTIGATION
NEEDS_MANUAL_INVESTIGATION ──(manual recheck finds terminal facts)──► RESOLVED
RESOLVED is final except: new complaint raised → IN_PROGRESS (complaint watch)
```
Complaint watch: raising a complaint starts a watch with the same schedule config (fresh budget).

---

## 7. APIs

### 7.1 Dashboard auth & users
- `POST /dashboard/api/login` `{ email, password }` → sets `rs_session` cookie (httpOnly, SameSite=Strict, Secure in production, Path=/), returns `{ user }`. 5 failed attempts per email → 15 min lock (config).
- `POST /dashboard/api/logout`, `GET /dashboard/api/me`.
- Sessions: random 32-byte token, stored as SHA-256 hash; idle timeout 30 min, absolute 12 h (config).
- CSRF: SameSite=Strict + all non-GET dashboard routes require header `X-Dashboard-Request: 1` (cannot be sent cross-site without CORS preflight, which we never allow).
- Users: `GET/POST /dashboard/api/users`, `PATCH /dashboard/api/users/:id` (role, disabled) — ADMIN only. Bootstrap: `POST /v1/dashboard-users` with the merchant **API key** creates users (needed to create the first admin). Emails globally unique, lower-cased. Password ≥ 12 chars.

Permission matrix:
| Action | ADMIN | SUPPORT | VIEWER |
|---|---|---|---|
| View overview / payments / cases / timelines | ✓ | ✓ | ✓ |
| Recheck now, add note, raise UDIR complaint | ✓ | ✓ | ✗ |
| Manage users | ✓ | ✗ | ✗ |

### 7.2 Dashboard data (`/dashboard/api`, session required)
| Method & path | Response |
|---|---|
| `GET /overview` | `{ total, succeeded, processing, failed, debitedNotCaptured, reversalsPending, casesNeedingAction }` (backend-computed) |
| `GET /payments?status&type&psp&from&to&minAmount&maxAmount&orderId&paymentId&upiRrn&cursor&limit` | `{ data: PaymentRow[], nextCursor }` |
| `GET /payments/search?q=` | resolves `q` as 12-digit RRN, payment id (`pay_`/`dbt_`), or order id → `{ matches: PaymentRow[] }` |
| `GET /payments/:type/:id` | `PaymentDetail` (identity, money panel, resolution panel, open case id) — emits `PAYMENT_VIEWED` |
| `GET /payments/:type/:id/timeline` | `{ events: TimelineItem[] }` (merchant-safe) |
| `POST /payments/:type/:id/recheck` | `PaymentDetail` (SUPPORT+) |
| `POST /payments/:type/:id/complaints` `{ reason }` | `Case` (SUPPORT+) |
| `GET /cases?status&cursor&limit` | `{ data: CaseRow[], counts: { needsAction, investigating, verificationPending, reversalPending, resolved } }` |
| `GET /cases/:id` | `CaseDetail` (+ complaint, notes, permitted actions for this user) — emits `CASE_VIEWED` |
| `POST /cases/:id/notes` `{ body }` | `Note` (SUPPORT+) |
| `POST /cases/:id/recheck` | `CaseDetail` (SUPPORT+) |

`PaymentRow`: `{ type: 'COLLECT'|'AUTOPAY', id, orderId, upiRrn, amountPaise, merchantStatus, merchantStatusLabel, customerDebit, capture, reversalStatus, pspId, createdAt, lastUpdatedAt, caseId }`.
`PaymentDetail` adds: `reversal { status, initiatedAt, completedAt }`, `verification { status, label }` (no counts/backoff), `npciTxnId`, `mode`, `actionsAllowed: string[]` (computed for current user).

### 7.3 Customer-safe
`GET /public/payments/:id/status` with header `X-Payment-Token: <token>` (query `?token=` also accepted for simple pages).
Token = `base64url(HMAC-SHA256(CUSTOMER_TOKEN_SECRET, "cst:v1:" + paymentId))` — scoped to one payment, recomputable so idempotent replays return the same token, no storage.
Response: `{ paymentId, status, message, amountPaise, updatedAt }`. 404 for unknown id or bad token (indistinguishable). `Access-Control-Allow-Origin: *`, no cookies, `Cache-Control: no-store`. Never calls a PSP.

### 7.4 `/v1` changes (additive only)
- `POST /v1/payments` accepts `orderId?`; response adds `customerStatusToken`, `merchantStatus`.
- `POST /v1/mandates/:id/debits` accepts `orderId?`.
- `GET /v1/payments/:id`: **read-only** (see C2); adds `merchantStatus`, `customerDebit`, `capture`, `reversal`, `upiRrn`.
- `POST /v1/dashboard-users` (bootstrap).

### 7.5 Errors
Existing `{ error: { code, message } }`. New codes: `FORBIDDEN` (403), `CHECK_IN_PROGRESS` (409), `RECHECK_TOO_SOON` (429), `COMPLAINT_NOT_ALLOWED` (422), `COMPLAINT_FAILED` (502), `ACCOUNT_LOCKED` (429).

---

## 8. Collect failover change (D10) — exact interpretation

**Current behaviour** (`src/routing/router.ts:84-95`): for each candidate PSP, attempt; only a
`TIMEOUT` triggers a status check (`resolveTimeout`). Every other technical decline —
`BANK_UNAVAILABLE`, `SWITCH_ERROR`, `PSP_ERROR` (including adapter exceptions caught in
`track()`) — **immediately fails over** to the next PSP with a new `txnRef`. This applies to both
`op: 'mandate'` and `op: 'collect'`.

**Risk for collect**: a collect request may have been created at PSP A even though the call
errored (e.g. connection reset after the PSP accepted it). Failing over sends a *second* collect
request from PSP B; the customer can approve both → double debit.

**Proposed behaviour** (`op: 'collect'` only): after a non-timeout technical decline, call
`status(txnRef)` on the same PSP once (no added wait) before failing over:
- `SUCCESS` → return success (no failover).
- `PENDING` → return `PENDING` (a live collect exists; Phase 3 poller takes over).
- `BUSINESS_DECLINE` → return it.
- `NOT_FOUND` / `TECHNICAL_DECLINE` / status call throws → fail over as today.

**Unchanged**: `op: 'mandate'`; timeout handling; health recording (status calls are already
excluded from health); budget handling (the status check is skipped if `maxTotalMs` is spent,
which falls back to *not* failing over — returning the technical decline — the safe choice).

**Files**: `src/routing/router.ts` (≈15 lines in `execute`), `test/routing/router.test.ts` (new cases).
**Compatibility**: one extra PSP status call per failed collect attempt; `payment_attempts` gains
`status` rows; some collects previously reported as failed-over may now return `PENDING`. The
existing API test (BANK_UNAVAILABLE → failover → success) still passes because the mock reports
the decline on status. Mandate-execution failover has the same theoretical risk; **not changed**
(out of D10 scope) — listed as a follow-up.

---

## 9. Conflicts / items needing confirmation at plan approval

- **C1 — AutoPay polling cadence.** Phase 1 already polls pending debits every 5 min for 48h.
  D5's schedule (5s/15s/…) would change Phase 1 behaviour if applied. **Proposal: leave the debit
  worker as is;** the new poller covers collects and post-failure AutoPay watches. Both end in
  `NEEDS_MANUAL_INVESTIGATION` after 48h, so the merchant experience is consistent.
- **C2 — `GET /v1/payments/:id` lazy refresh removed.** Today it calls the PSP for pending
  payments. With the poller, concurrent PSP polling is forbidden by D5, so the GET becomes
  read-only and the Phase 2 test "pending payment is refreshed on read" is rewritten to
  "pending payment is resolved by the poller". This is the only Phase 2 behaviour change besides D10.
- **C3 — Late capture after FAILED** is surfaced as a `STATUS_MISMATCH` case rather than flipping
  the payment to SUCCEEDED (no contradictory webhooks).
- **C4 — Terminology**: "UPI transaction ID" in search = the 12-digit RRN/UPI Ref No; the
  35-char NPCI txn id is shown separately when the PSP provides it.

---

## 10. Frontend (`dashboard/`, served at `/dashboard`)

```
dashboard/
  index.html            shell: nav, <main id="view">
  styles.css            tokens (light/dark), layout, badge colours per merchantStatus
  app.js                hash router (#/overview, #/payments, #/payments/:type/:id, #/cases, #/cases/:id, #/users, #/login)
  api/client.js         fetch wrapper: credentials, X-Dashboard-Request header, error → toast
  components/           status-badge.js, money-panel.js, timeline.js, table.js, filters.js, toast.js
  views/                login.js, overview.js, payments.js, payment-detail.js, cases.js, case-detail.js, users.js
```
Components render server-supplied enums/labels; the only client logic is formatting (₹, dates in
IST), routing, and hiding buttons not in `actionsAllowed` (the server still enforces). Search box
in the header on every page. UI states per view: loading, empty, error, forbidden.

---

## 11. Testing
- Pure: `nextCheckAt` schedule (each boundary, exhaustion), `reduce` transition table, derive
  functions (merchant/customer/case status — table-driven), token sign/verify.
- Poller on PGlite with FakeClock: pending → captured at 3rd check; failed-TD → debited →
  reversal initiated → completed (case opened → reversal pending → resolved); exhausted at 48h →
  NEEDS_MANUAL_INVESTIGATION + case NEEDS_ACTION; lease prevents concurrent checks; manual recheck
  vs poller race; late capture → STATUS_MISMATCH.
- Router: collect failover cases (status SUCCESS / PENDING / NOT_FOUND / throws / budget spent);
  mandate unchanged.
- Auth: login/lockout/session expiry/logout; role matrix on every mutating route; CSRF header.
- Customer endpoint: valid token, wrong token, token for another payment, no internal fields.
- UDIR: raise (MOCK mode recorded), idempotency, not allowed when NOT_DEBITED, status advance.
- Regression: all 100 existing tests stay green (API test for lazy refresh rewritten per C2).
- Dashboard: static assets served; manual walkthrough in the browser pane before completion.

---

## 12. Implementation notes (deviations found while building)

Recorded so the spec matches the shipped code. None changes a product decision (D1–D10, C1–C4).

1. **Merchant status `SCHEDULED`** — an AutoPay debit waiting for its execution slot would
   otherwise read as "verifying" after 45 s. Customer mapping: `processing`.
2. **Merchant status `CAPTURED_AFTER_FAILURE`** — the merchant-facing face of C3 (late capture),
   instead of showing "Failed" while money was captured. Customer mapping: `verification_in_progress`.
3. **"Mark resolved" case action** (`POST /cases/:id/close`, SUPPORT+, note required, only from
   `NEEDS_ACTION`) — a `STATUS_MISMATCH` case can only be settled by a human decision; without
   it the case would stay in "Needs action" forever. Uses the `CLOSED_BY_MERCHANT` resolution.
4. **UDIR complaint resolved as `RESOLVED_REVERSED` records an observed reversal** (reversal
   facts → `COMPLETED`), so the money panel, merchant status and customer status agree with the
   complaint. No further complaint is allowed once the amount is reversed.
5. **Manual recheck never starts a watch** on a payment whose verification is `NOT_REQUIRED` or
   `RESOLVED`; it refreshes the facts only.
6. **SQL mirror of merchant status** (`merchantStatusSql`) so list filters and overview counts run
   in Postgres; a test asserts it agrees with `merchantStatus()` across every fact combination.
7. **`GET /dashboard/api/meta`** serves status/type labels and PSP modes so the UI hard-codes no
   domain vocabulary.
8. **Detail views prompt to refresh** when the backend changes them (15 s, our API only, ignores
   routine status checks; never auto-redraws under the user).
9. **`payment_events.seq`** orders events written within the same millisecond.
10. **Collect domain transitions from the poller** go through `applyPaymentOutcome`, now guarded to
    `PENDING` rows only, so Phase 2 webhooks/savings fire exactly once.
