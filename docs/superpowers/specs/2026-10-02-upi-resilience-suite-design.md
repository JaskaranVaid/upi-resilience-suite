# UPI Payment Resilience Suite — Design (Phase 1 + Phase 2)

Date: 2026-10-02
Source: "UPI Taxation Business Gap Analysis" (Section 5 master plan)

## 1. Goal

A B2B API middleware that sits between a merchant's billing/checkout systems and their
payment service providers (PSPs) and:

- **Engine A (Phase 1):** never lets a UPI AutoPay debit execute inside an NPCI peak window,
  keeps the RBI 24-hour pre-debit notice valid for the actual execution slot, and never burns a
  mandate's retry budget on doomed attempts.
- **Engine B (Phase 1):** quotes the true merchant cost of each payment method under the
  October 2026 MDR regime, offers a discount-only incentive toward cheaper methods, and splits
  marketplace carts by genuine vendor ownership.
- **Smart Router (Phase 2):** picks the healthiest PSP, fails over on technical declines,
  retries timeouts safely (status check first), and never retries business declines.
- **Savings ledger:** records every rescued/avoided/recovered rupee so Phase 4 analytics can be
  built on it.

Out of scope for this build: UI, real PSP integrations (adapter interface only + mocks),
Phase 3 (status poller / dispute desk), Phase 4 (analytics UI), multi-region.

## 2. Compliance guardrails (non-negotiable invariants)

1. **No surcharging.** No payment method's customer price may exceed the cart amount. Steering
   is discount-only. Enforced in code and covered by property-style tests.
2. **No fee structuring.** Engine B never splits a single merchant-of-record's amount into
   multiple transactions. Splits are derived only from line-item vendor ownership; each vendor
   appears in exactly one leg; legs sum exactly to the cart.
3. **Comply with, don't evade, peak windows.** No debit executes inside a configured peak or
   blackout window; the worker re-checks immediately before execution.
4. **Pre-debit notice integrity.** Execution only happens on the date stated in a notice sent
   ≥ 24h (+ buffer) earlier. If a reschedule moves past that date, a fresh notice is sent.
5. **No double debits.** A timed-out attempt is status-checked before any retry; debits are
   idempotent on `(merchantId, idempotencyKey)`.
6. **All regulatory numbers are config**, versioned by `effectiveFrom`. Figures in the source
   document (₹2,000 threshold, 0.4% / ₹300 cap, peak windows) post-date our verification ability
   and must be confirmable/editable without code changes.

## 3. Architecture

Modular monolith, TypeScript + Fastify, two process roles from one codebase:

- `api` — Fastify HTTP server.
- `worker` — polls Postgres for due debits (`FOR UPDATE SKIP LOCKED`), executes via router,
  dispatches webhooks from an outbox.

Both can run in one process for dev (`npm run dev`). Storage is Postgres via Drizzle ORM;
dev/tests use PGlite (in-process WASM Postgres), production uses `DATABASE_URL`.

Redis/BullMQ was dropped from the original sketch: Postgres is already the source of truth, and
a SKIP-LOCKED poller gives second-level precision with one less moving part.

```
src/
  config/      regulatory rules (versioned), app config from env
  rules/       PURE functions: time windows, slot selection, MDR, steering, split
  clock.ts     injectable clock
  db/          drizzle schema, client factory (pglite | pg), migrations
  psp/         PspAdapter interface, normalized result codes, MockPsp
  routing/     health tracker, router (failover + safe retry)
  scheduler/   Engine A: debit intake, notice, state machine, worker
  checkout/    Engine B: quote + split services
  ledger/      savings events
  webhooks/    outbox + HMAC-signed dispatcher
  api/         fastify app, auth, routes
  main.ts      entrypoint (api | worker | all)
```

## 4. Rules (pure, no I/O)

All times in IST (`Asia/Kolkata`, fixed UTC+05:30, no DST). Rules take an explicit `Date` and
rule config; no hidden clock.

### 4.1 Time windows
- `peakWindows`: `[{start:"10:00", end:"13:00"}, {start:"17:00", end:"21:30"}]` (end-exclusive).
- `blackoutWindows`: default `[{start:"23:30", end:"00:30"}]` (wraps midnight) — bank CBS
  maintenance; configurable, may be empty.
- `preferredWindows`: where load is spread; default `[{start:"13:00", end:"17:00"}]`, with
  fallback to any non-restricted time if a preferred window cannot satisfy constraints.
- `isRestricted(t)` = in any peak or blackout window.

### 4.2 Slot selection — `chooseSlot({ earliest, notBeforeDate?, debitId, config })`
1. Find the first preferred window opening (in IST) whose window end > `earliest`.
2. Slot = max(window start, earliest) + jitter, where jitter = `hash(debitId) mod` remaining
   window length (minus a 60 s safety margin). Deterministic per debit.
3. If no preferred window works on that day, use the next one. Result is guaranteed
   non-restricted (asserted).

### 4.3 MDR — `computeMdr({ amountPaise, category, merchant, rules })`
Money is integer paise throughout. Default rule table (effectiveFrom 2026-10-15):

| Case | MDR |
|---|---|
| P2P | 0 |
| P2M amount ≤ ₹2,000 | 0 |
| Small merchant (flag set by merchant profile: < ₹1 lakh/month via direct QR) | 0 |
| Exempt sectors (railways, telecom, insurance, fuel, utilities), > ₹2,000 | flat ₹5 |
| Capital markets, > ₹2,000 | 0.02%, cap ₹300 |
| General P2M, > ₹2,000 | 0.4%, cap ₹300 |

Percent fees rounded half-up to the paisa. Before the effective date, the pre-reform zero-MDR
rule set applies.

### 4.4 Method cost & steering — `quote({ amountPaise, category, merchant, rules })`
- Per-merchant method costs (merchant-negotiated, configurable): `UPI` (from 4.3), `NETBANKING`,
  `RUPAY_DEBIT`, `CARD` — each `{ percentBps, flatPaise, capPaise? }`.
- Output per method: `merchantCostPaise`, `customerDiscountPaise`, `customerPayablePaise`.
- Steering: let `best` = cheapest-for-merchant method other than UPI. If
  `savings = cost(UPI) − cost(best) ≥ steering.minSavingsPaise`, offer
  `discount = min(floor(savings × steering.shareBps / 10000), steering.maxDiscountPaise)`.
  Merchant net benefit `savings − discount` must be > 0, else no offer.
- Invariant: `customerPayablePaise ≤ amountPaise` for every method; UPI payable == amount.

### 4.5 Marketplace split — `splitCart({ lineItems, vendors, rules })`
- Each line item has `vendorId`; vendors have their own category / small-merchant flag.
- Group by vendor; one leg per vendor; leg MDR computed with that vendor's profile.
- Validation: non-empty, positive integer amounts, every vendor known, legs sum to total.
- Returns legs + `consolidatedMdrPaise` (as if single merchant of record) vs `splitMdrPaise`
  for transparency. This is only valid where each vendor is genuinely the merchant of record
  — documented in API docs.

## 5. Engine A — AutoPay scheduler

### 5.1 Intake
`POST /v1/mandates/:mandateId/debits { amountPaise, dueDate?(YYYY-MM-DD), idempotencyKey }`
- `earliest = max(now + 24h + noticeBuffer, start of dueDate in IST)`.
- `slot = chooseSlot(earliest)`. Send the pre-debit notice now via the mandate's primary PSP
  stating the slot's IST date + amount (sending earlier than 24h ahead is permitted; later is
  not), then persist the debit as SCHEDULED with `noticeDate = slot date`.
- If the notice send fails, the debit is not created (502) — the merchant can safely retry
  with the same idempotency key.
- Amount must be ≤ mandate max amount. Mandate must be ACTIVE.
- Duplicate idempotency key → returns the existing debit (200), no new side effects.
- Ledger: if intake time was in a peak window, mark `requestedInPeak = true`.

### 5.2 States
`SCHEDULED → EXECUTING → SUCCEEDED | FAILED`, with `TECH_DECLINE` returning to `SCHEDULED`
(next slot) while attempts remain, `NOTICE_EXPIRED → (re-notify) → SCHEDULED` when the next slot
falls beyond the notified date, and `BUSINESS_DECLINE → FAILED` immediately.
(Notice sending is synchronous at intake, so there's no separate NOTIFIED state.)

### 5.3 Worker
Every `pollIntervalMs` (default 1000): claim up to N debits with `state = SCHEDULED AND
scheduled_at <= now` using `FOR UPDATE SKIP LOCKED`, set `EXECUTING`, then for each:
1. Re-check `isRestricted(now)` → if restricted, reschedule (no attempt consumed).
2. Re-check notice date == today (IST) → else NOTICE_EXPIRED handling.
3. Call router `executeMandate`. Map outcome to state transitions above.
Stale `EXECUTING` rows (> `executingTimeoutMs`) are reclaimed by status check (crash safety).

### 5.4 Retry budget
`maxAttempts` per debit (default 3, config). Attempts counted per worker execution (router-level
micro-retries within one execution count as one mandate attempt only if the PSP saw at most one
debit — guaranteed because retries reuse the same `txnRef` after a status check).

### 5.5 Webhooks
`debit.scheduled`, `debit.succeeded`, `debit.failed` — written to `webhook_outbox` in the same
transaction as the state change; dispatcher POSTs with `X-Resilience-Signature:
sha256=HMAC(secret, timestamp + "." + body)` and `X-Resilience-Timestamp`, exponential backoff,
max 8 attempts.

## 6. Smart Router (Phase 2)

### 6.1 PSP adapter
```ts
interface PspAdapter {
  id: string;
  sendPreDebitNotice(req): Promise<NoticeResult>;
  executeMandate(req: { txnRef, mandateRef, amountPaise }): Promise<PspResult>;
  collect(req: { txnRef, payerVpa, amountPaise }): Promise<PspResult>;
  status(txnRef): Promise<PspResult>;
}
type PspResult =
  | { kind: 'SUCCESS', pspTxnId }
  | { kind: 'PENDING' }
  | { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' | 'BANK_UNAVAILABLE' | 'SWITCH_ERROR' | 'PSP_ERROR' }
  | { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' | 'WRONG_PIN' | 'MANDATE_REVOKED' | 'LIMIT_EXCEEDED' | 'OTHER' }
  | { kind: 'NOT_FOUND' }
```
Adapters must normalize timeouts (client-side deadline) into `TECHNICAL_DECLINE/TIMEOUT`.
`MockPsp` is scriptable (queue of outcomes) and probabilistic (seeded RNG, rates, latency).

### 6.2 Health tracking
Per PSP sliding window (last `windowSize` = 50 outcomes, in-process). Score = success rate over
technical outcomes (business declines are excluded — they aren't the PSP's fault). Circuit
breaker: if ≥ `minSamples` and TD rate ≥ `openThreshold` → OPEN for `cooldownMs`, then
HALF_OPEN (one probe).

### 6.3 Routing algorithm
Candidates = mandate's `eligiblePsps` (MIC-portable mandates may list several; otherwise one),
ordered by: closed circuits first, then score desc, then configured priority.
For each candidate, until `maxTotalMs` budget is spent:
1. Attempt. SUCCESS → done. BUSINESS_DECLINE → stop, return it.
2. TIMEOUT → wait `timeoutRetryDelayMs` (default 3000–5000 jittered), call `status(txnRef)`:
   SUCCESS → done; PENDING → return PENDING (never retry while pending); NOT_FOUND/declined →
   retry once on the same PSP with the same txnRef.
3. BANK_UNAVAILABLE / SWITCH_ERROR / PSP_ERROR, or the retry also failed → fail over to next
   candidate with a new txnRef.
Every attempt is recorded in `payment_attempts`. If final SUCCESS after ≥1 technical decline →
ledger `TD_RECOVERED`.

### 6.4 One-off payments
`POST /v1/payments { amountPaise, payerVpa, idempotencyKey, method? }` → router.collect.
Used for checkout UPI collect in the MVP.

## 7. Savings ledger
`savings_events(type, amountPaise, refId)`:
- `PEAK_DEFERRAL_RESCUED` — debit requested in a peak window, succeeded after deferral.
  amountPaise = debit amount (revenue protected).
- `TD_RECOVERED` — final success after ≥1 technical decline. amount = payment amount.
- `MDR_STEERING_OFFERED` / `MDR_STEERING_ACCEPTED` — net merchant savings (accepted is recorded
  via `POST /v1/checkout/quotes/:id/accept`).
`GET /v1/savings?from&to` returns totals by type.

## 8. Data model (Postgres)
merchants, vendors, mandates, debits, payments, payment_attempts, checkout_quotes,
savings_events, webhook_outbox. Money columns `bigint` paise. Timestamps `timestamptz`.
Unique `(merchant_id, idempotency_key)` on debits and payments.

## 9. API & auth
- `Authorization: Bearer <apiKey>`; keys stored as SHA-256 hashes.
- `POST /v1/merchants` (admin token via `ADMIN_TOKEN`) creates a merchant and returns the key once.
- Routes: merchants, vendors, mandates, debits, payments, checkout/quote, checkout/split,
  checkout/quotes/:id/accept, savings, health (`GET /health`, `GET /v1/psps/health`).
- Validation with zod; errors as `{ error: { code, message } }`.

## 10. Testing
- Unit (pure): windows incl. boundaries & midnight wrap, slot selection never restricted
  (exhaustive minute sweep across a week), MDR table rows & caps & rounding, steering invariants
  (randomized), split validation.
- Router: scripted MockPsp — timeout→status SUCCESS (no retry), timeout→NOT_FOUND→retry,
  bank-unavailable→failover, business decline→no retry, circuit breaker opens/closes.
- Scheduler integration on PGlite with a fake clock: 10:30 request → notice + slot ≥ 24h later
  in preferred window; idempotency; TD reschedule; attempts exhausted → FAILED + webhook;
  worker refuses to execute in peak window; notice expiry re-notify.
- API e2e via `fastify.inject` on PGlite.
