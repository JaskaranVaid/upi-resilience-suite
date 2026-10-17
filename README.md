# Merchantflo

B2B UPI payment-resilience middleware. It sits behind a merchant's billing system and checkout and
turns the 2025–26 UPI changes (AutoPay peak-hour execution rules, the coming P2M MDR) from a cost
into a managed problem.

**Where we are:** [roadmap](docs/roadmap.md) · [regulatory fact sheet](docs/regulatory/fact-sheet.md) ·
[decision records](docs/decisions/) · [founder actions](docs/roadmap/external-actions.md)

**Integrating?** Start with the [integration guide](docs/integration-guide.md). The API reference is
served at `/docs` (OpenAPI at `/openapi.json`), the drop-in checkout at `/checkout/v1/checkout.js`, and
there is a typed [Node SDK](sdk/node/README.md) with a webhook verifier.

| Module | Problem | What it does |
|---|---|---|
| **Engine A — Peak-aware AutoPay scheduler** | NPCI blocks AutoPay execution 10:00–13:00 and 17:00–21:30 IST; RBI requires a pre-debit notice ≥ 24h ahead | Accepts debits whenever the merchant's cron fires, sends the notice, executes in an off-peak slot (spread, not a 13:01 spike) at least 24h later — on the due date when sent 2+ days ahead ([ADR 0009](docs/decisions/0009-engine-a-notice-timing.md)) — never on an un-notified date, never burning the retry budget on doomed attempts |
| **Engine B — MDR-aware checkout** | 0.4% MDR (cap ₹300) on P2M UPI > ₹2,000 — announced for 15 Oct 2026, **postponed by NPCI**; starts when `MDR_EFFECTIVE_FROM` is set | Costs every accepted method, offers a **discount-only** incentive toward cheaper methods, estimates a vendor-ownership split of marketplace carts (no payments created) |
| **Smart Router (Phase 2)** | Bank/PSP technical declines | Health-scored PSP selection (time-weighted, with low-rate probing so no provider is starved after a bad patch) with circuit breakers, failover, and timeout handling that checks status before any retry |
| **Savings ledger** | Proving ROI | Every rescued payment and saved fee is recorded once, exposed at `/v1/savings` |
| **Status poller (Phase 3)** | Payments stuck "pending", or failed after the customer was debited | Backend poller checks unresolved payments on a configurable schedule (5s/15s/30s/45s → every minute to 15 min → every 15 min to 48h), tracks debit / capture / bank auto-reversal, then hands over to manual investigation |
| **Cashfree integration** | Running on a real PSP | UPI AutoPay via Cashfree's controlled notify → execute flow (Engine A keeps timing control), UPI collect, status/inquiry with auto-refund reversal facts, signed webhooks — see the [runbook](docs/runbooks/cashfree.md) |
| **Value analytics (Phase 4)** | Proving ROI every billing cycle | Value delivered per source (each with a method note), success uplift vs a no-recovery baseline, PSP performance, payment-issue outcomes, monthly statement (printable + CSV line items) |
| **Pilot (Phase 7)** | Moving a merchant's live AutoPay without betting its collections on day one | Shadow (plan only) → canary by mandate → full, decided at intake and stated in every response (`executedBy`); "what you would have saved" report, double-debit detector, a scorecard of the five pass criteria that gates full rollout — see the [pilot runbook](docs/runbooks/pilot.md) |
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
- **No double debits.** Timeouts are status-checked before retrying; any technical decline
  (collect or mandate execution) is status-checked before failing over to another PSP;
  idempotency keys everywhere.
- **No silent debits above the no-AFA limit.** AutoPay debits above ₹15,000 (or a mandate's
  declared limit, at most ₹1 lakh) need customer authentication and are refused at intake (`AFA_REQUIRED`).
- **Savings are counted when real.** MDR steering savings are booked only when the steered payment is
  reported paid, never when the method is merely chosen.
- **No invented deadlines.** No refund/reversal due date is computed until a rule is confirmed
  for a specific UPI failure category with a cited source (`REVERSAL_DEADLINE_RULES` is empty).
- **"Captured" ≠ "settled".** Capture means PSP-confirmed; bank settlement isn't ingested and is
  never claimed.

All regulatory numbers live in [`src/config/rules.ts`](src/config/rules.ts), versioned by
effective date; their sources and confidence are in the [fact sheet](docs/regulatory/fact-sheet.md).
The MDR start date is configuration (`MDR_EFFECTIVE_FROM`): unset means not in force.

## Quick start

```bash
npm install
npm test                 # full suite on in-process PGlite Postgres — no Docker needed
npm run demo             # Phase 1–2 time-compressed simulation with mock PSPs
npm run demo:dashboard   # Phase 3: seeds investigation scenarios, serves http://localhost:3100/dashboard/
npm run dev              # API + worker + poller on :3000, data in .data/pg
```

Configuration is read from environment variables, or from a `.env` file in the project folder
(see [`.env.example`](.env.example); shell variables win over `.env`). On Windows PowerShell set a
variable with `$env:NAME = "value"`, not `NAME=value command`.

`demo:dashboard` prints local demo logins (admin / support / viewer); if port 3100 is busy it picks
the next free port and says so. Everything is mock: no real
PSP, NPCI or money is involved, and simulated UDIR complaints are labelled as such in the UI.

## Production

One Docker image runs every role: `ROLE=api` (HTTP), `ROLE=worker` (debit executor, status poller,
settlement reconciliation, webhook dispatcher; any number of replicas — rows are claimed with
`FOR UPDATE SKIP LOCKED`), and `ROLE=migrate` (apply migrations and exit, once per deploy). In
production (`NODE_ENV=production`) processes never migrate on start; they refuse to run against a
database missing a migration ([decision 0007](docs/decisions/0007-expand-contract-migrations.md)).

```bash
docker compose up -d --build --wait   # postgres + migrate + api (:3000) + worker, production settings
bash scripts/compose-smoke.sh         # readiness, onboarding, an AutoPay debit, ops metrics
npm run build && npm run start:prod   # or without Docker: compiled dist/
```

- **AWS Mumbai** (dev, staging, production): Terraform in [`infra/`](infra/README.md) — VPC, RDS
  PostgreSQL, ECS Fargate, ALB + WAF, KMS/Secrets Manager, CloudWatch alarms.
- **Deploys**: GitHub Actions builds once on `main`, migrates, rolls staging; production promotes
  the same image ([deploy runbook](docs/runbooks/deploy.md)).
- **Health**: `GET /healthz` (liveness, no database), `GET /readyz` (503 while draining or without a
  database). On SIGTERM an api reports not-ready, waits `SHUTDOWN_DRAIN_MS`, finishes in-flight
  requests and exits.
- **Observability**: JSON log lines; the worker logs an `ops.metrics` line every minute
  (restricted-window executions, notice failures, backlogs, dead webhooks, open PSP circuits),
  also at `GET /v1/admin/ops/metrics` (admin token). [Alerts runbook](docs/runbooks/alerts.md).
- **Drills**: [load tests](docs/runbooks/load-testing.md), [backup restore](docs/runbooks/backup-restore.md),
  alarm fire drills (`scripts/drills/`).

Required in production: `DATABASE_URL=postgres://…` (TLS via `?sslmode=verify-full&sslrootcert=…`),
`ADMIN_TOKEN`, `CUSTOMER_TOKEN_SECRET`, `CREDENTIALS_KEYS`. Behind a load balancer set `TRUST_PROXY`
to the number of proxy hops (e.g. `1`) or the proxies' CIDRs (`true` is refused: it lets clients
spoof their IP). Merchant webhook URLs must be https on public hosts (`WEBHOOK_TARGETS=public-only`).
See [`.env.example`](.env.example).

## Security, privacy and the ops console

- **Ops console** (`/ops/`) for Merchantflo staff: password + authenticator code at every sign-in,
  OWNER/OPERATOR/VIEWER roles, every action audited. Accounts come from a shell:
  `npm run ops:operator -- create --email … --name … --role OWNER --recipient-key op.pub`; new credentials are
  only ever printed encrypted to the operator's public key ([operators runbook](docs/runbooks/operators.md)).
- **Kill switch**: pause new money movement globally, per merchant or per PSP in seconds; nothing is
  cancelled and status checks, reconciliation and webhooks carry on ([runbook](docs/runbooks/kill-switch.md)).
- **Pilots and duplicates** in the ops console: each pilot's stage, gates, scorecard and shadow report,
  stage changes (rollback never gated; an owner override records what it overrode), and the queue of
  suspected double debits to confirm or dismiss ([pilot runbook](docs/runbooks/pilot.md)).
- **Dashboard two-factor sign-in**, optional per user (Security page); admins can reset a member's.
- **Customer data encrypted at rest**: VPAs, phone numbers, payment links/QR and webhook payloads are
  sealed by the application (AES-256-GCM, key derived from `CREDENTIALS_KEYS`); `npm run privacy:backfill`
  seals older rows and re-seals after key rotation.
- **Retention and erasure (DPDP)**: the worker redacts identifiers on finished payments/sessions after
  `PERSONAL_DATA_RETENTION_DAYS` (180) and deletes webhook logs after `WEBHOOK_LOG_RETENTION_DAYS` (30);
  `POST /v1/privacy/erasure` removes one customer's identifiers from a merchant's records.
- **CI gates**: `npm audit` (high/critical), CodeQL, gitleaks, Trivy on the image. See [SECURITY.md](SECURITY.md),
  the [threat model](docs/security/threat-model.md), [incident response](docs/runbooks/incident-response.md),
  and the legal drafts for counsel in [`docs/legal/`](docs/legal/retention-policy.md).

## Merchants, modes and PSP connections

Merchantflo never holds funds: each merchant connects **its own** PSP accounts
([ADR 0002](docs/decisions/0002-merchants-own-psp-accounts.md)).

- **Mode.** A merchant is `TEST` (default) or `LIVE`, fixed at onboarding (`POST /v1/merchants { mode }`).
  Test merchants get `sk_test_…` keys and may use sandbox/mock PSPs, including the *shared* adapters
  configured on the server (`MOCK_PSPS`, a platform Cashfree sandbox). Live merchants get `sk_live_…`
  keys and route **only** through their own production connections — never a shared or mock one.
- **Connections.** `POST /v1/psp-connections { provider: "cashfree", credentials: { clientId, clientSecret } }`
  checks the keys with Cashfree, then stores them sealed (AES-256-GCM, `CREDENTIALS_KEYS`). The
  connection id (`con_…`) is the PSP id everywhere: put it in a mandate's `eligiblePsps`, and point the
  PSP's webhooks at the connection's `webhookUrl`. `provider: "mock"` gives a test merchant a simulated PSP.
- **No PSP, no payment.** A merchant with nothing to route through gets `422 NO_PSP_CONNECTED`.
- **Existing mandates.** `POST /v1/mandates/import` (JSON or CSV, ≤ 5,000 rows, `verify` asks the PSP).
- **Providers.** Cashfree (AutoPay + every checkout channel) and Razorpay (one-off payments only — it can't
  run AutoPay on our timing); runbooks: [Cashfree](docs/runbooks/cashfree.md), [Razorpay](docs/runbooks/razorpay.md).

## Checkout channels

`POST /v1/payments { channel }` — `UPI_COLLECT` (needs `payerVpa`), `UPI_INTENT` (default without a VPA),
`UPI_QR`, `NETBANKING` (optionally `netbankingBankCode`) or `CARD`. The response's `customerAction` says what
the customer does next: open `UPI_INTENT.url` (or an app-specific `appUrls` entry), render `UPI_QR.qrData`,
follow a `REDIRECT`, or open the PSP's own checkout with `PSP_CHECKOUT.params` (card details never touch
Merchantflo). Only PSPs supporting the channel are tried; an idempotent replay returns the same action.

## Settlement reconciliation

The worker reads each connection's settlement report every morning (yesterday, IST; failed or missing days
are retried for a week), stores each line once and matches it to payments. Payment detail shows
**Settled to your bank?** with UTR, net amount and PSP fees; `GET /v1/settlements` lists report lines
(matched/unmatched); the monthly statement has a settlement section. A settled amount that differs from the
captured one, or a capture still unsettled 3 days after its day was reconciled, opens a *needs action* case.
Settlement data never changes a payment's state.

## API

All `/v1` routes take `Authorization: Bearer <merchant API key>`, except merchant onboarding
which takes the admin token. Money is always integer **paise**. Errors: `{ "error": { "code", "message" } }`.
Rate limits (per minute): 1,200 per API key on `/v1`, 20 per IP on dashboard login, 300 per IP on
`/public`, 600 per dashboard session, and 30 failed authentications per IP (invalid API keys, admin tokens
or session cookies — checked before any lookup); over a limit → `429 RATE_LIMITED`.

| Method & path | Purpose |
|---|---|
| `POST /v1/merchants` *(admin)* | Onboard; returns `apiKey` and `webhookSecret` once |
| `GET /v1/merchants/me`, `PATCH /v1/merchants/me` | Merchant profile and settings (name, webhook URL, category, method costs, steering) |
| `POST /v1/merchants/me/webhook-secret/rotate` | New webhook signing secret, returned once |
| `POST /v1/api-keys`, `GET /v1/api-keys`, `POST /v1/api-keys/:id/revoke` | Key rotation (the key is shown once; the last active key can't be revoked) |
| `POST /v1/psp-connections`, `GET /v1/psp-connections`, `PATCH /v1/psp-connections/:id` | The merchant's own PSP accounts (credentials checked, sealed, never returned) |
| `POST /v1/mandates/import` | Bulk import of existing mandates: JSON `{ mandates, verify? }` or `text/csv` |
| `PATCH /v1/mandates/:id`, `POST /v1/mandates/move-psp` | Re-point mandates to another of the merchant's PSPs (one, or every mandate on PSP `from`) |
| `PATCH /v1/admin/merchants/:id` *(admin)* | Change a merchant's mode; revokes all keys and returns a new one |
| `POST /v1/vendors`, `GET /v1/vendors` | Marketplace vendors (`externalId`, `category`, `smallMerchant`) |
| `POST /v1/mandates` | Register a mandate (`eligiblePsps` omitted = all portable PSPs; `noAfaLimitPaise` ≤ ₹1 lakh for eligible categories) |
| `POST /v1/mandates/:id/revoke` | Stop future debits |
| `POST /v1/mandates/:id/debits` | **Engine A intake** — `{ amountPaise, dueDate? }` + `Idempotency-Key` |
| `GET /v1/debits/:id`, `GET /v1/debits?state=` | Debit status |
| `GET /v1/pilot`, `GET /v1/pilot/scorecard`, `GET /v1/pilot/report` | Pilot stage; the five pass criteria and the shadow report for `month` or `from`/`to` |
| `POST /v1/pilot/executions` | What the merchant's own system did with its debits (JSON or `text/csv`); also takes a history export for a backtest |
| `GET /v1/shadow-debits?reported&before`, `GET /v1/shadow-debits/:id` | Debits the merchant's system executes during a pilot (`executedBy: MERCHANT`) |
| `POST /v1/checkout/sessions`, `GET /v1/checkout/sessions/:id` | Checkout session for checkout.js: methods with payable amounts and steering discount, `clientToken`; savings booked when the steered payment succeeds |
| `GET /v1/webhook-deliveries?status&event&before`, `POST /v1/webhook-deliveries/:id/redeliver` | Webhook delivery log; redeliver a delivered or failed webhook (same id, signed afresh) |
| `GET /openapi.json`, `GET /docs` *(no auth)* | OpenAPI 3.1 document and the API reference page |
| `POST /v1/checkout/quote` | **Engine B** — per-method cost + optional steering `offer` |
| `POST /v1/checkout/quotes/:id/accept` | Record the method the customer chose (books nothing) |
| `POST /v1/checkout/quotes/:id/paid` | `{ method, paymentReference }` — the payment succeeded; books the steering saving once |
| `POST /v1/checkout/split` | Estimate only: vendor-ownership split with per-leg MDR; creates no payments and pays nothing out |
| `POST /v1/payments`, `GET /v1/payments/:id` | One-off payment via the smart router: `channel`, `payerVpa?`, `netbankingBankCode?`, `client?`; returns `customerAction` |
| `GET /v1/settlements?from&to&match=` | Settlement report lines from the merchant's PSPs, matched to payments where possible |
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

Sent at 10:30 on 15 Oct without a due date, it runs on the 16th: the customer must be notified
24 hours ahead. Sent 2 or more days before its `dueDate`, a debit runs on that date
([ADR 0009](docs/decisions/0009-engine-a-notice-timing.md)).

### Webhooks

| Event | When |
|---|---|
| `debit.scheduled` | Debit accepted and slotted (notice sent, or `noticePending` when deferred) |
| `debit.notice_sent` | A deferred or re-sent pre-debit notice went out |
| `debit.rescheduled` | Moved to a later slot; `reason`: `RESTRICTED_WINDOW`, `NOTICE_DATE` or `TECHNICAL_DECLINE` |
| `debit.succeeded`, `debit.failed` | Final debit outcome |
| `payment.succeeded`, `payment.failed` | Final collect outcome |
| `payment.reversal_initiated`, `payment.reversed` | The customer's bank is reversing / has reversed an uncaptured debit |
| `payment.captured_after_failure` | The PSP captured a payment after it was reported failed — fulfil or refund |
| `case.needs_action`, `case.resolved` | A payment issue needs the merchant / was resolved |
| `pilot.stage_changed` | The merchant's pilot moved between shadow, canary and full |

Payment-issue events carry `paymentType`, `paymentId`, `orderId`, `amountPaise`, `upiRrn`,
`customerDebit`, `capture`, `reversal` and, when relevant, `case` — never internal PSP codes.
Headers: `x-resilience-event`, `x-resilience-delivery`, `x-resilience-timestamp`,
`x-resilience-signature: sha256=HMAC_SHA256(webhookSecret, "<timestamp>.<raw body>")`.
Written in the same transaction as the state change (outbox), retried with exponential backoff
(20 s doubling to an hourly cap, for about 3 days), then marked failed for redelivery.

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
src/ops/         Phase 5: JSON logs, health probes, heartbeat, ops metrics, database verifier
src/pilot/       Phase 7: rollout stages, debit intake, shadow debits, execution reports, shadow report, duplicates, scorecard
dashboard/       Phase 3: static vanilla-JS console (no build step)
infra/           Phase 5: Terraform (AWS Mumbai)
scripts/deploy/  Phase 5: ECS deploy (migrate, roll, verify)
scripts/drills/  Phase 5: restore and alarm drills; scripts/load-test.ts
```

## Phase 3 — status polling & Payment Resolution Console (dashboard)

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

## Phase 4 — value & revenue-recovery analytics

The **Value** section of the console (all roles, read-only) answers "what did the suite deliver
this billing month?" using only the merchant's own data. Billing month = calendar month in IST;
custom ranges up to 366 days are also supported.

| Line | Counted from | Notes |
|---|---|---|
| **Recovered by smart routing & safe retries** (headline) | `TD_RECOVERED` | First attempt failed technically, payment later captured via failover / safe retry / status verification |
| Protected from the peak-hour AutoPay embargo | `PEAK_DEFERRAL_RESCUED` | Debits requested in a peak window to run right away (no `dueDate`, or `dueDate` = that day); counted at full amount, assuming a peak-window attempt would have been declined — stated on screen |
| MDR saved through payment-method steering | `MDR_STEERING_ACCEPTED` | Net of the customer discount |
| Further MDR savings offered but not taken | offered − accepted | Context only, not in totals |

- **Success uplift**: actual success rate vs "without recovery" (payments that succeeded and whose
  first attempt didn't fail technically) on the same traffic.
- **PSP performance**: technical success (customer declines and pending approvals don't count
  against a provider), failure categories, p50/p95 response times, daily trend, live routing state.
- **Payment issues**: opened/resolved, median time to resolve, bank auto-reversals completed,
  UDIR complaints (simulated ones counted separately).
- **Monthly statement**: printable page, `statement.csv` (summary with method notes) and
  `value-events.csv` (every payment behind each rupee). CSV cells are formula-injection safe.

API: `GET /dashboard/api/analytics/{value,psps,issues}?month=YYYY-MM | from&to`,
`GET /dashboard/api/analytics/{statement,value-events}.csv?month=YYYY-MM`.

## What is mocked / not yet built

- **Real PSP: Cashfree** (`src/psp/cashfree/`), verified against Cashfree's documented API with
  contract tests; run `npm run smoke:cashfree` against the sandbox before go-live and work through
  the runbook checklist. Mock PSPs remain for development and demos (refused in production unless
  `ALLOW_MOCK_PSPS=true`). Adding another PSP = implementing `PspAdapter` (incl. its
  `capabilities`). Router health is per-process (move to Redis when running many API instances).
- **UDIR complaints depend on the PSP.** Cashfree offers no merchant-raised UDIR API, so for
  Cashfree payments the dashboard explains that the customer raises it from their UPI app; the
  mock PSP still demonstrates the flow (labelled simulated). Lookups always go through PSP APIs —
  non-bank entities can't query the NPCI switch.
- **Merchant-initiated refunds** are out of scope for Phase 3 (bank auto-reversals are tracked).
- **Savings attribution** for peak rescues assumes the debit would otherwise have fired in the
  embargo window: it was *requested* during one, to run right away (no `dueDate`, or a `dueDate`
  of that same day). A debit requested for a later due date earns no peak credit (a recovered
  technical decline on it still counts as routing recovery). Steering savings reported through
  `POST /v1/checkout/quotes/:id/paid` for a payment Merchantflo did not process are shown but not
  verified; billing (Phase 8) must count only verified value.
- **What real PSPs allow today.** AutoPay mandates at Cashfree and Razorpay run only through the PSP
  they were registered with (not portable: [fact sheet §4](docs/regulatory/fact-sheet.md)), so
  failover between PSPs covers checkout payments; an AutoPay debit is retried at its own PSP.
  Neither PSP has an API for merchant-raised UDIR complaints (above). Razorpay connections take
  one-off payments only, so Engine A needs a Cashfree account. PayU, the third aggregator in the
  founding brief, is not built (Phase 9, when a design partner needs it). AutoPay failover across
  PSPs and API-raised UDIR complaints work end to end only against mock PSPs today.
- **Marketplace split is an estimate.** `POST /v1/checkout/split` returns one leg per vendor with
  its MDR; it creates no payment and pays nothing out. Splitting the *payout* of one customer
  payment would not avoid MDR either: MDR is charged on the customer's payment, so only separate
  payments to each vendor (each its own merchant of record, with its own PSP account) are charged
  per leg. Marketplace payouts are Phase 9, after counsel question 3.
- **Invoicing / pricing** from the value delivered is not built (Phase 4 reports value only).
