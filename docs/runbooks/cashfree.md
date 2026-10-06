# Runbook — Cashfree Payments

Design and rationale: [`docs/superpowers/specs/2026-10-03-real-psp-cashfree-design.md`](../superpowers/specs/2026-10-03-real-psp-cashfree-design.md).

## 1. Configure

| Variable | Value |
|---|---|
| `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` | From the Cashfree merchant dashboard (sandbox and production keys differ). Secret store only — never commit. |
| `CASHFREE_ENV` | `sandbox` (default) or `production` |
| `CASHFREE_TIMEOUT_MS` | Client-side request timeout, default `10000` |
| `MOCK_PSPS` | Set **empty** (`MOCK_PSPS=`) to run Cashfree only. In production, mocks refuse to start unless `ALLOW_MOCK_PSPS=true`. |

On boot the server logs `payment providers: cashfree (SANDBOX|LIVE), …` — check it.

**Webhooks**: in the Cashfree dashboard, point payment, refund and subscription webhooks at
`https://<your-host>/webhooks/psp/cashfree`. Signatures are verified with the client secret
(raw body, ±5 min timestamp window). Webhooks only trigger an immediate status re-check; the poller
works without them, just with more latency.

## 2. How the integration behaves

- **UPI AutoPay** uses Cashfree's *controlled* flow. Register mandates with
  `mandateRef` = the Cashfree **subscription_id** and `eligiblePsps: ["cashfree"]`
  (Cashfree mandates aren't portable; mixing PSPs is rejected).
  - Pre-debit notice: sent ≥ 25 h + 30 min before execution (Cashfree's 25 h rule).
  - Due dates more than 6 days out: the notice is **deferred** and sent ~6 days before
    (Cashfree accepts notices for T+1…T+7). The debit shows `noticePending: true` until then.
  - Execution: at the off-peak slot Engine A chose; execution id = our txnRef, base payment id = our debit id.
- **UPI collect** (`POST /v1/payments`) needs `customerPhone` (Cashfree requirement). The collect is
  `PENDING` until the customer approves in their UPI app; the poller (and webhooks) resolve it.
- **Debited but failed**: Cashfree auto-refunds; those refunds drive the Phase 3 reversal facts
  (reversal initiated/completed). Merchant-initiated refunds are not handled by this suite.
- **UDIR complaints**: Cashfree has no merchant API for them — the dashboard explains that the
  customer raises them from their UPI app.

## 3. Sandbox smoke test (before go-live, and after any Cashfree API version change)

Put your **sandbox** keys (Cashfree dashboard → Developers → API keys, test mode) in a `.env` file in
the project folder. It is gitignored; never commit real keys:

```
CASHFREE_CLIENT_ID=<sandbox app id>
CASHFREE_CLIENT_SECRET=<sandbox secret key>
```

Then, from any shell (PowerShell, cmd or bash):

```
npm run smoke:cashfree
```

Or set them for one PowerShell session instead of using `.env`:

```powershell
$env:CASHFREE_CLIENT_ID = "<sandbox app id>"; $env:CASHFREE_CLIENT_SECRET = "<sandbox secret key>"; npm run smoke:cashfree
```

Optional steps (set in `.env` or with `$env:NAME = "value"` in PowerShell):

| Variables | Step |
|---|---|
| `SMOKE_UPI_ID` + `SMOKE_PHONE` | ₹1 UPI collect to a [Cashfree test VPA](https://www.cashfree.com/docs/api-reference/payments/data-to-test-integration), e.g. `testsuccess@gocash`, `testfailure@gocash`, `testinsufficientfunds@gocash`, `testtimeoutbank@gocash`; any 10-digit phone |
| `SMOKE_CREATE_SUBSCRIPTION=1` | Create a sandbox ON_DEMAND UPI subscription and authorise it with `testsuccess@gocash`; prints its id |
| `SMOKE_SUBSCRIPTION_ID` | Send a pre-debit notification for that (ACTIVE) subscription; prints a payment id |
| `SMOKE_SUBSCRIPTION_ID` + `SMOKE_EXECUTE_PAYMENT_ID` | ≥ 25 h later: execute the notified payment |

The script refuses `CASHFREE_ENV=production` and never prints credentials.

### Sandbox results so far (2026-10-06)

- Credentials and the order lookup path work (unknown order → `NOT_FOUND`).
- UPI collect works end to end with the adapter's default headers: `testsuccess` → `SUCCESS`
  (debited, captured); `testfailure` → customer decline; `testinsufficientfunds` →
  `INSUFFICIENT_FUNDS`; `testtimeoutbank` → technical decline with the customer debit `UNKNOWN`
  (kept under watch). The raw responses are pinned in `test/psp/cashfree.test.ts`.
- Cashfree ids are 19-digit JSON strings (kept exact).
- **UPI AutoPay: blocked on account activation.** Subscriptions can be created, but authorisation
  stays `INITIALIZED`. Cashfree's FAQ: UPI AutoPay activation is *not self-serve*; it must be
  requested from Cashfree for the sandbox and production accounts.

## 4. Go-live checklist — confirm these in sandbox first

These are documented gaps in Cashfree's API reference; the adapter is deliberately conservative
about each, but confirm and, if needed, tighten the mapping in `src/psp/cashfree/mapping.ts`:

0. [ ] **Ask Cashfree to activate UPI AutoPay** on the sandbox and production accounts (support form
       or account manager). Then: `SMOKE_CREATE_SUBSCRIPTION=1` → notify → execute 25 h later.
1. [ ] Exact `execution_status` / `payment_status` strings for controlled executions (unknown values
       are treated as `PENDING`: re-checked, never retried).
2. [x] `POST /orders/sessions` (UPI collect) works server-side with the adapter's default `x-client-*`
       headers (sandbox, 2026-10-06; configurable via `collectClientHeaders`).
3. [ ] Auto-refunds for failed payments appear in `GET /orders/{id}/refunds` (refund webhooks also
       trigger a re-check either way).
4. [ ] UPI collect is enabled for your **production** merchant account (works in sandbox; NPCI
       restricts collect for some P2M use).
5. [ ] Webhook timestamp unit (ms per docs example; seconds also accepted).
6. [ ] `CASHFREE_ENV=production`, production keys, `MOCK_PSPS=` empty, webhook URL updated.

## 5. Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| Log: "Cashfree rejected the credentials" | 401/403 from Cashfree | Wrong keys or wrong `CASHFREE_ENV` |
| Debits failing with `NOTICE_FAILED` | Notification refused (e.g. `Prev_PDN_In_Progress`, limits) | Worker retries every 15 min; check the subscription is active |
| Executions `LIMIT_EXCEEDED` | Cashfree's max executions per payment reached | Debit fails; merchant retries next cycle |
| Many payments in "verification in progress" | Collect awaiting customer approval, or lookups failing | Check `/v1/psps/health` and server logs for lookup errors |
| Webhooks 401 | Signature/timestamp rejected | Check the client secret and server clock (NTP) |
