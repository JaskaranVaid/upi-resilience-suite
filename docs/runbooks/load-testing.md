# Runbook — Load testing

`scripts/load-test.ts` onboards a few **test-mode** merchants (shared mock PSPs: no real PSP, no
money) and sends an open-loop mix at a fixed rate — new requests start on schedule even when the
system slows down, which is how real traffic behaves:

| Share | Request |
|---|---|
| 35% | `POST /v1/checkout/sessions` |
| 20% | `POST /v1/payments` (UPI collect) |
| 20% | `POST /v1/mandates/:id/debits` (AutoPay intake; the worker then plans and executes them) |
| 25% | `GET /v1/debits` |

It refuses to run unless `LOAD_TARGET_ENV` is `local`, `dev` or `staging`.

```sh
LOAD_TARGET_ENV=staging LOAD_BASE_URL=https://api.staging.merchantflo.in LOAD_ADMIN_TOKEN=<staging admin token> \
LOAD_MERCHANTS=10 LOAD_RPS=100 LOAD_DURATION_S=600 npm run load:test
```

| Variable | Default | |
|---|---|---|
| `LOAD_MERCHANTS` | 5 | Each merchant's API key allows 1,200 requests/min (20 rps): use ≥ `LOAD_RPS / 15` |
| `LOAD_RPS`, `LOAD_DURATION_S` | 20, 60 | Target rate and length |
| `LOAD_P95_MS`, `LOAD_MAX_ERROR_RATE` | 500, 0.001 | Pass/fail thresholds (429s are reported but not errors) |
| `LOAD_MAX_IN_FLIGHT` | 200 | Requests not sent because this many were waiting count as a failure |

**The WAF limits each client IP to 6,000 requests per 5 minutes (~20 rps).** For higher rates run the
script from several machines at once, or raise `waf_rate_limit_per_5_minutes` for staging in
`infra/envs/staging/main.tf` for the test and put it back afterwards.

Watch while it runs: the CloudWatch dashboard (API latency, ECS CPU, database CPU and connections,
backlogs). Afterwards: `debitBacklog`, `webhookBacklog` and `pollerBacklog` return to 0 within
minutes, and no alarm other than expected ones fired.

**Targets for M1 (staging, pilot sizing):** 100 rps for 10 minutes with p95 < 500 ms, error rate
< 0.1%, autoscaling adding api tasks, no backlog left 10 minutes after the run. The pilot's real
peak is far lower (a mid-size OTT merchant: tens of thousands of debits a day, ~1–2 rps averaged).

The merchants it creates stay in the database, named `Load test <run> #n`; they're test-mode and
harmless.

| Date | Env | Rate × duration | p50 / p95 / p99 ms | Errors | Notes | By |
|---|---|---|---|---|---|---|
| 2026-10-15 | local (docker compose) | 15 rps × 20 s | 20 / 91 / 103 | 0 / 300 | Laptop, one api + one worker | — |
