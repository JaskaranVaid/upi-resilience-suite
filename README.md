# UPI Payment Resilience Suite

B2B middleware that sits behind a merchant's billing system and checkout and turns the
October 2026 UPI changes from a cost into a managed problem:

| Module | Problem | What it does |
|---|---|---|
| **Engine A — Peak-aware AutoPay scheduler** | NPCI blocks AutoPay execution 10:00–13:00 and 17:00–21:30 IST; RBI requires a pre-debit notice ≥ 24h ahead | Accepts debits whenever the merchant's cron fires, sends the notice, executes in an off-peak slot (spread, not a 13:01 spike), never on an un-notified date, never burning the retry budget on doomed attempts |
| **Engine B — MDR-aware checkout** | 0.4% MDR (cap ₹300) on P2M UPI > ₹2,000 from 15 Oct 2026 | Costs every accepted method, offers a **discount-only** incentive toward cheaper methods, splits marketplace carts by vendor ownership |
| **Smart Router (Phase 2)** | Bank/PSP technical declines | Health-scored PSP selection with circuit breakers, failover, and timeout handling that checks status before any retry |
| **Savings ledger** | Proving ROI | Every rescued payment and saved fee is recorded once, exposed at `/v1/savings` |

Source brief: *UPI Taxation Business Gap Analysis* (Section 5, Phases 1–2).
Design: [`docs/superpowers/specs/2026-10-02-upi-resilience-suite-design.md`](docs/superpowers/specs/2026-10-02-upi-resilience-suite-design.md).

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
- **No double debits.** Timeouts are status-checked before retrying; idempotency keys everywhere.

All regulatory numbers live in [`src/config/rules.ts`](src/config/rules.ts), versioned by
effective date. **Verify them against the current NPCI/RBI circulars before go-live.**

## Quick start

```bash
npm install
npm test            # 100 tests, uses in-process PGlite Postgres — no Docker needed
npm run demo        # time-compressed simulation with mock PSPs
npm run dev         # API + worker on :3000, data in .data/pg
```

Production: set `DATABASE_URL=postgres://…` and `ADMIN_TOKEN`, run `ROLE=api` and `ROLE=worker`
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
```

## What is mocked / not yet built

- **PSPs are mocks.** Integrating a real gateway = implementing `PspAdapter` (4 methods) and
  normalising its codes into `PspResult`. Router health is per-process (move to Redis when
  running many API instances).
- **Savings attribution** for peak rescues assumes the debit would otherwise have fired in the
  embargo window (it was *requested* during one). That's the brief's model; confirm it matches
  how you'll bill customers.
- **Phase 3** (status poller UI, UDIR dispute desk) and **Phase 4** (analytics dashboard) are
  not built. The ledger and `payment_attempts` table are their data source. Note: dispute/status
  lookups must go through PSP/aggregator APIs — non-bank entities cannot query the NPCI switch
  directly.
