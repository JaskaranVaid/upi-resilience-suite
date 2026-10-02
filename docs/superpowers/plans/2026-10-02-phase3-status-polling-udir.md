# Phase 3 — Status Polling & UDIR Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend status poller, unified payment read model, case/UDIR service, role-based dashboard auth, customer-safe status endpoint and a static merchant dashboard — on top of Phases 1–2 without changing their behaviour except D10 and C2.

**Architecture:** New `tracking/` domain (pure reducer + service + poller) owns money facts and verification beside the untouched `payments`/`debits` state machines; `disputes/` owns cases, notes and complaints; `auth/` owns dashboard users/sessions; a SQL view unifies Collect + AutoPay for reads; `dashboard/` is static ES-module UI over `/dashboard/api`.

**Tech Stack:** existing (Node 24, TS, Fastify 5, Drizzle, PGlite/pg, zod 4, Vitest) + `@fastify/cookie`, `@fastify/static`.

**Spec:** `docs/superpowers/specs/2026-10-02-phase3-status-polling-udir-design.md`

## Global Constraints

- Phase 1–2 behaviour preserved except: D10 collect failover (§8) and C2 read-only `GET /v1/payments/:id`.
- No regulatory deadline values anywhere (D1). `REVERSAL_DEADLINE_RULES` stays empty.
- All polling timings come from `PollingConfig`; no literals in services.
- Frontend never computes payment/case/customer status and never calls PSPs.
- No PSP-specific branching outside `src/psp/*` adapters.
- Internal PSP codes, check counts and backoff never appear in dashboard or customer responses.
- Every new transition is a pure function with table-driven tests.
- Each task ends with `npm run typecheck` and `npm test` green, then a commit.

---

### Task 1: Collect status-check-before-failover (D10)
**Files:** Modify `src/routing/router.ts` (`execute`); Test `test/routing/router.test.ts`.
**Change:** for `req.op === 'collect'`, after a non-timeout `TECHNICAL_DECLINE` and if budget remains, `status(txnRef)` on the same PSP; `SUCCESS|PENDING|BUSINESS_DECLINE` → return; else fail over. If budget is spent → return the decline without failover.
**Tests (new):** collect PSP_ERROR + status PENDING → returns PENDING, PSP B untouched; collect BANK_UNAVAILABLE + status NOT_FOUND → fails over; status throws → fails over; status SUCCESS → success, no failover; mandate BANK_UNAVAILABLE still fails over with no status call (regression); budget spent → no failover.

### Task 2: PSP contract additions + MockPsp + registry
**Files:** Modify `src/psp/types.ts`, `src/psp/mock.ts`; Create `src/psp/registry.ts`; Test `test/psp/mock.test.ts`.
**Produces:** `PspAdapter.mode`, `inquire`, `raiseComplaint`, `complaintStatus`; types `TransactionInquiry`, `ComplaintRequest`, `ComplaintResult`, `ComplaintStatus`, `ComplaintStatusResult`; `PspResult` SUCCESS `upiRrn?`; `PspRegistry { get(id): PspAdapter; ids(): string[] }`. Mock: deterministic 12-digit RRN from txnRef hash; `scriptInquiry(txnRef, TransactionInquiry[])` (advances per call, last repeats); default inquiry derived from ledger; complaint refs `MOCK-UDIR-<n>`, `scriptComplaint(statuses[])`.
**Tests:** RRN deterministic & 12 digits; inquiry defaults for SUCCESS / declined / unknown; scripted progression; complaint idempotency key returns same ref; `mode === 'MOCK'`.

### Task 3: Config + pure tracking logic
**Files:** Create `src/config/polling.ts`, `src/tracking/schedule.ts`, `src/tracking/derive.ts`, `src/tracking/reduce.ts`, `src/tracking/types.ts`; Modify `src/config/rules.ts` (empty `REVERSAL_DEADLINE_RULES` + type); Tests `test/tracking/schedule.test.ts`, `derive.test.ts`, `reduce.test.ts`.
**Produces:**
- `DEFAULT_POLLING: PollingConfig`; `nextCheckAt(startedAt, checkCount, cfg): Date | null`.
- `merchantStatus(input): { code: MerchantStatus; label: string }`, `customerStatus(code, facts): { status: CustomerStatus; message: string }`, `caseStatus(input): CaseStatus` (spec §5 tables).
- `reduce(input: ReduceInput): ReduceOutput` — `{ facts, verificationStatus, nextCheckAt, events: NewEvent[], caseAction, domainOutcome }` (spec §6.3).
**Tests:** schedule offsets 5/15/30/45 s, 1-min steps to 15 min, 15-min steps to 48 h, then null; every row of the §5 tables; reducer table: pending→captured, failedTD→debited→reversal initiated→completed, exhausted, late capture → STATUS_MISMATCH (no domain flip), not-debited → resolved, inquiry not found keeps watching, no duplicate events when facts unchanged.

### Task 4: Schema migration
**Files:** Modify `src/db/schema.ts`; Generate `drizzle/0001_*.sql`; Create custom `drizzle/0002_merchant_payments_view.sql` (`drizzle-kit generate --custom`); Modify `test/helpers/fixtures.ts` (truncate list); Test `test/db/schema.test.ts`.
**Adds:** `payment_tracking`, `payment_cases`, `udir_complaints`, `case_notes`, `payment_events`, `dashboard_users`, `dashboard_sessions`; `payments.order_id`, `debits.order_id`; view `merchant_payments_v` (UNION ALL of payments + debits with normalized columns, LEFT JOIN tracking).
**Tests:** migrations apply on PGlite; view returns both types; unique `(subject_type, subject_id)`; existing schema tests unchanged.

### Task 5: Event recording + merchant-safe timeline
**Files:** Create `src/events/record.ts`, `src/events/timeline.ts`; Test `test/events/timeline.test.ts`.
**Produces:** `recordEvents(tx, events: NewEvent[])`; `toTimeline(rows, usersById): TimelineItem[]` — whitelist per type, collapses consecutive `STATUS_CHECKED` into "Status checked N times", drops audit-only types, never returns `data` raw.
**Tests:** label mapping per type; no internal fields leak (assert on keys); collapse behaviour; MOCK complaint labelled.

### Task 6: TrackingService + StatusPoller + hooks into Phases 1–2
**Files:** Create `src/tracking/service.ts`, `src/tracking/poller.ts`; Modify `src/payments/service.ts` (start tracking after router outcome; emit `PAYMENT_CREATED`/`PAYMENT_SUBMITTED`/`PAYMENT_STATE_CHANGED`; remove lazy refresh from `get` — C2; expose `settle` for tracking), `src/scheduler/worker.ts` (additive: upsert tracking + emit events on succeed/fail/pending; start watch on final technical failure; `UNRESOLVED_PENDING` → NEEDS_MANUAL_INVESTIGATION), `src/context.ts`, `src/main.ts` (poller in worker loop; MOCK warning in production); Tests `test/tracking/poller.test.ts`, update `test/api/api.test.ts` (C2 rewrite).
**Produces:** `TrackingService.startOrUpdate(...)`, `TrackingService.check(trackingId, actor): Promise<CheckResult>` (lease-guarded), `StatusPoller.runOnce(): Promise<number>`.
**Tests:** spec §11 poller list; debit worker regression (all scheduler tests unchanged and green); payment create still settles synchronously when the router returns a definitive result.

### Task 7: DisputeService (cases, notes, complaints, recheck)
**Files:** Create `src/disputes/service.ts`; Test `test/disputes/service.test.ts`.
**Produces:** `recheck(subject, actor)`, `addNote(caseId, actor, body)`, `raiseComplaint(subject, actor, reason)`, `listCases(merchantId, filter)`, `getCase(merchantId, caseId)`.
**Rules:** complaint allowed when customer_debit ≠ NOT_DEBITED and no open complaint; adapter failure → `COMPLAINT_FAILED`, nothing persisted; success persists complaint with adapter `mode`, opens/updates case, restarts watch; manual recheck cooldown → `RECHECK_TOO_SOON`.
**Tests:** each rule; MOCK mode stored; complaint status advance via poller resolves case; notes append with author.

### Task 8: Dashboard auth, users, roles
**Files:** Create `src/auth/passwords.ts`, `src/auth/sessions.ts`, `src/auth/users.ts`, `src/api/dashboard/auth.ts` (plugin: cookie, session guard, `requireRole`, CSRF header check), `src/api/routes/dashboard-users.ts`; Modify `src/api/app.ts` (register cookie + dashboard plugins), `src/api/routes/merchants.ts` (bootstrap `POST /v1/dashboard-users`), `src/errors.ts` (new codes), `src/config/env.ts` (`SESSION_*`, `CUSTOMER_TOKEN_SECRET`); `package.json` (+ `@fastify/cookie`, `@fastify/static`); Test `test/auth/auth.test.ts`.
**Tests:** scrypt hash/verify; login success sets httpOnly SameSite=Strict cookie; wrong password; lockout after 5; idle + absolute expiry; logout revokes; disabled user rejected; CSRF header required on POST; role matrix for every mutating route; bootstrap via API key; email uniqueness; audit events `USER_CREATED`, `LOGIN_*`.

### Task 9: Unified read model + dashboard data API
**Files:** Create `src/query/payments.ts` (PaymentQueryService over `merchant_payments_v`), `src/api/routes/dashboard.ts`; Test `test/api/dashboard.test.ts`.
**Endpoints:** spec §7.2.
**Tests:** overview counts across both types; filters (status/type/psp/date/amount/order/payment/RRN); cursor pagination; search by 12-digit RRN, by `pay_`/`dbt_` id, by order id; detail has no internal fields; timeline; `PAYMENT_VIEWED`/`CASE_VIEWED` recorded; cross-merchant isolation (404).

### Task 10: Customer status token + `/v1` additive fields
**Files:** Create `src/payments/customer-token.ts`, `src/api/routes/public.ts`; Modify `src/api/routes/payments.ts`, `src/api/routes/mandates.ts`, `src/api/schemas.ts`, `src/payments/service.ts` (`paymentView` additive fields); Test `test/api/public.test.ts`, extend `test/api/api.test.ts`.
**Tests:** token returned on create and identical on idempotent replay; valid token → customer status; wrong token / other payment's token → 404; response keys exactly `{paymentId,status,message,amountPaise,updatedAt}`; CORS + no-store headers; endpoint performs zero PSP calls (assert mock `calls` unchanged); `orderId` accepted and round-trips.

### Task 11: Static dashboard
**Files:** Create `dashboard/index.html`, `dashboard/styles.css`, `dashboard/app.js`, `dashboard/api/client.js`, `dashboard/components/*.js`, `dashboard/views/*.js`; Modify `src/api/app.ts` (`@fastify/static` at `/dashboard/`); Test `test/api/dashboard-static.test.ts`.
**Tests:** `/dashboard/` serves index with correct content-type; JS modules served; unknown asset 404. Manual: walk login → overview → search RRN → payment detail → case → note → recheck → raise complaint (MOCK badge) in the browser pane, light + dark, 375 px width.

### Task 12: Demo, docs, final verification
**Files:** Modify `scripts/demo.ts` (Phase 3 scenario: debited-not-captured → auto-reversal; exhausted → needs action; seed a dashboard admin and print login), `README.md`, `.env.example`.
**Verify:** `npm run typecheck`, `npm test` (all old + new), `npm run demo`, live server smoke via curl + browser walkthrough.
