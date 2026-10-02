# UPI Payment Resilience Suite

B2B middleware that sits behind a merchant's billing system and checkout and turns the
October 2026 UPI changes from a cost into a managed problem:

| Module | Problem | What it does |
|---|---|---|
| **Engine A — Peak-aware AutoPay scheduler** | NPCI blocks AutoPay execution 10:00–13:00 and 17:00–21:30 IST; RBI requires a pre-debit notice ≥ 24h ahead | Accepts debits whenever the merchant's cron fires, sends the notice, executes in an off-peak slot (spread, not a 13:01 spike), never on an un-notified date, never burning the retry budget on doomed attempts |
| **Engine B — MDR-aware checkout** | 0.4% MDR (cap ₹300) on P2M UPI > ₹2,000 from 15 Oct 2026 | Costs every accepted method, offers a **discount-only** incentive toward cheaper methods, splits marketplace carts by vendor ownership |
| **Smart Router (Phase 2)** | Bank/PSP technical declines | Health-scored PSP selection with circuit breakers, failover, and timeout handling that checks status before any retry |
| **Savings ledger** | Proving ROI | Every rescued payment and saved fee is recorded once, exposed at `/v1/savings` |
| **Status poller (Phase 3)** | Payments stuck "pending", or failed after the customer was debited | Backend poller checks unresolved payments on a configurable schedule (5s/15s/30s/45s → every minute to 15 min → every 15 min to 48h), tracks debit / capture / bank auto-reversal, then hands over to manual investigation |
| **Payment Resolution Console (Phase 3)** | "I was charged but my order failed" | Merchant dashboard at `/dashboard`: search by 12-digit UPI reference, see what happened to the customer's money, Dispute Desk queues, recheck, notes, raise UDIR complaints, audit timeline |

Source brief: *UPI Taxation Business Gap Analysis* (Section 5, Phases 1–3).
Designs: [Phases 1–2](docs/superpowers/specs/2026-10-02-upi-resilience-suite-design.md) ·
[Phase 3](docs/superpowers/specs/2026-10-02-phase3-status-polling-udir-design.md).

## Compliance stance

These are enforced in code and covered by tests:

- **No surcharging.** UPI is always priced at the cart amount; steering only ever *discounts*
  another method. NPCI requires MDR to be borne by the merchant.
- **No fee structuring.** Carts are split only by genuine vendor ownership (each vendor is
  merchant of record). A single merchant's payment is never chunked under ₹2,000 to dodge MDR.
- **Comply with the embargo, don't evade it.** The worker re-checks windows immediately before
  executing.
- **Pre-debit notice integrity.** Execution only on the date stated in a notice sent ≥ 24h earlier;
  a reschedule that changes the date triggers a fresh notice.
- **No double debits.** Timeouts are status-checked before retrying; a failed collect is
  status-checked before failing over to another PSP; idempotency keys everywhere.
- **No invented deadlines.** No refund/reversal due date is computed until a rule is confirmed
  for a specific UPI failure category with a cited source (`REVERSAL_DEADLINE_RULES` is empty).
- **"Captured" ≠ "settled".** Capture means PSP-confirmed; bank settlement isn't ingested and is
  never claimed.

All regulatory numbers live in [`src/config/rules.ts`](src/config/rules.ts), versioned by
effective date. **Verify them against the current NPCI/RBI circulars before go-live.**

## Quick start

```bash
npm install
npm test                 # 249 tests, in-process PGlite Postgres — no Docker needed
npm run demo             # Phase 1–2 time-compressed simulation with mock PSPs
npm run demo:dashboard   # Phase 3: seeds investigation scenarios, serves http://localhost:3100/dashboard/
npm run dev              # API + worker + poller on :3000, data in .data/pg
```

`demo:dashboard` prints local demo logins (admin / support / viewer). Everything is mock: no real
PSP, NPCI or money is involved, and simulated UDIR complaints are labelled as such in the UI.

Production: set `DATABASE_URL=postgres://…`, `ADMIN_TOKEN` and `CUSTOMER_TOKEN_SECRET`, run `ROLE=api` and `ROLE=worker`
as separate processes (any number of workers — rows are claimed with `FOR UPDATE SKIP LOCKED`).
See [`.env.example`](.env.example).

## API

All `/v1` routes take `Authorization: Bearer <merchant API key>`, except merchant onboarding
which takes the admin token. Money is always integer **paise**. Errors: `{ "error": { "code", "message" } }`.

| Method & path | Purpose |
|---|---|
| `POST /v1/merchants` *(admin)* | Onboard; returns `apiKey` and `webhookSecret` once |
| `GET /v1/merchants/me` | Merchant profile |
| `POST /v1/vendors`, `GET /v1/vendors` | Marketplace vendors (`externalId`, `category`, `smallMerchant`) |
| `POST /v1/mandates` | Register a mandate (`eligiblePsps` omitted = MIC-portable across all PSPs) |
| `POST /v1/mandates/:id/revoke` | Stop future debits |
| `POST /v1/mandates/:id/debits` | **Engine A intake** — `{ amountPaise, dueDate? }` + `Idempotency-Key` |
| `GET /v1/debits/:id`, `GET /v1/debits?state=` | Debit status |
| `POST /v1/checkout/quote` | **Engine B** — per-method cost + optional steering `offer` |
| `POST /v1/checkout/quotes/:id/accept` | Record the method the customer paid with |
| `POST /v1/checkout/split` | Vendor-ownership split with per-leg MDR |
| `POST /v1/payments`, `GET /v1/payments/:id` | One-off UPI collect via the smart router |
| `GET /v1/savings?from&to` | Revenue protected and fees saved |
| `GET /v1/psps/health` | Router health and circuit state |
| `GET /v1/rules` | The regulatory parameters currently applied |

### Example: billing cron fires at 10:30 AM

```http
POST /v1/mandates/mdt_…/debits
Idempotency-Key: inv-2026-10-0042
{ "amountPaise": 49900 }
```
```json
{ "state": "SCHEDULED", "requestedInPeak": true, "noticeDate": "2026-10-16",
  "scheduledAt": "2026-10-16T08:47:13.000Z", "attempts": 0, "maxAttempts": 3 }
```

### Webhooks

`debit.scheduled`, `debit.succeeded`, `debit.failed`, `payment.succeeded`, `payment.failed`.
Headers: `x-resilience-event`, `x-resilience-delivery`, `x-resilience-timestamp`,
`x-resilience-signature: sha256=HMAC_SHA256(webhookSecret, "<timestamp>.<raw body>")`.
Written in the same transaction as the state change (outbox), retried with exponential backoff.

## Debit lifecycle

```
SCHEDULED ──(due, off-peak, notice date = today)──► EXECUTING ─► SUCCEEDED
    ▲                                                 │
    │  technical decline, attempts left               ├─► FAILED (business decline / attempts exhausted)
    ├─────────────────────────────────────────────────┤
    │  PENDING → status re-checked every 5 min        └─► PENDING_CONFIRMATION
    │  in peak / wrong date → re-slot (re-notice if date changes), no attempt consumed
```
Crashed workers: `EXECUTING` rows untouched for 5 min are reconciled by status lookup only.

## Layout

```
src/rules/       pure regulatory logic: IST windows, slot choice, MDR, steering, split
src/config/      versioned rule sets, env
src/psp/         PspAdapter contract + seeded MockPsp
src/routing/     health tracker (circuit breaker) + router
src/scheduler/   Engine A intake (service) and executor (worker)
src/checkout/    Engine B
src/payments/    one-off routed payments
src/ledger/      savings events
src/webhooks/    outbox, dispatcher, signing
src/api/         Fastify app, auth, routes, zod schemas
src/tracking/    Phase 3: money facts, polling schedule, pure reducer, status derivations, poller
src/disputes/    Phase 3: cases, notes, UDIR complaints, recheck
src/auth/        Phase 3: dashboard users, passwords, sessions
src/query/       Phase 3: unified Collect + AutoPay read model
src/events/      Phase 3: audit log + merchant-safe timeline
dashboard/       Phase 3: static vanilla-JS console (no build step)
```

## Phase 3 — status polling & Payment Resolution Console

**Statuses.** Internal state (PSP codes, check counts, backoff) never leaves the backend. Two
derived views, both computed server-side in [`src/tracking/derive.ts`](src/tracking/derive.ts):

- *Merchant status* — e.g. "Payment verification in progress", "Customer debited, payment not
  captured", "Auto-reversal to customer in progress", "Needs manual investigation".
- *Customer status* — `processing`, `success`, `failed`, `verification_in_progress`,
  `refund_processing`, `refunded`, each with a plain message ("Please don't make another payment").

**Dashboard users.** The first admin is created with the merchant API key
(`POST /v1/dashboard-users`); after that, admins manage the team in the console. Roles: `ADMIN`
(users + actions), `SUPPORT` (recheck, notes, UDIR complaints, close), `VIEWER` (read-only).
Email + password (scrypt), httpOnly SameSite=Strict session cookie, 30-min idle / 12-h absolute
expiry, lockout after 5 failures, CSRF header on writes.

**Customer status for checkout pages.** `POST /v1/payments` returns `customerStatusToken`. The
checkout page polls `GET /public/payments/:id/status` with header `X-Payment-Token`; it reads only
that payment's customer-safe status and never touches a PSP.

**Dashboard API** (`/dashboard/api`, cookie session):

| Method & path | Purpose |
|---|---|
| `GET /overview` | Counts by what needs attention |
| `GET /payments?status&type&psp&from&to&minAmount&maxAmount&orderId&paymentId&upiRrn&cursor` | Unified Collect + AutoPay list |
| `GET /payments/search?q=` | 12-digit UPI ref, payment id or order id |
| `GET /payments/:type/:id`, `…/timeline` | Investigation view + merchant-safe audit timeline |
| `POST /payments/:type/:id/recheck`, `…/complaints` | Recheck now · raise UDIR complaint (SUPPORT+) |
| `GET /cases?status=`, `GET /cases/:id` | Dispute Desk |
| `POST /cases/:id/notes`, `…/recheck`, `…/close` | Notes · recheck · mark resolved with a note (SUPPORT+) |
| `GET/POST /users`, `PATCH /users/:id` | Team management (ADMIN) |

**Audit.** Every state change, status check, UDIR action, note, view and login is appended to
`payment_events`, which feeds the timelines and, later, Phase 4 analytics.

## What is mocked / not yet built

- **PSPs are mocks.** Integrating a real gateway = implementing `PspAdapter` and normalising its
  codes into `PspResult` / `TransactionInquiry`. Router health is per-process (move to Redis when
  running many API instances).
- **UDIR is mock-backed.** `inquire`, `raiseComplaint` and `complaintStatus` are implemented by
  `MockPsp` (mode `MOCK`, labelled in the UI). A real PSP adapter replaces it without touching the
  dashboard. Lookups go through PSP/aggregator APIs; non-bank entities can't query the NPCI switch.
- **Merchant-initiated refunds** are out of scope for Phase 3 (bank auto-reversals are tracked).
- **Savings attribution** for peak rescues assumes the debit would otherwise have fired in the
  embargo window (it was *requested* during one). That's the brief's model; confirm it matches
  how you'll bill customers.
- **Phase 4** (analytics) is not built; `payment_events`, `payment_tracking` and `savings_events`
  are its data sources.
