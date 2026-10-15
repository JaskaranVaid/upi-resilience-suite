# Runbook — Alerts

Alarms are defined in [`infra/modules/monitoring`](../../infra/modules/monitoring/main.tf) and
publish to the SNS topic `merchantflo-<env>-alarms` (e-mail subscribers confirm once). Each alarm's
description links to its section here. Severity: **critical** = merchants are being harmed now,
act immediately; **high** = act within the hour; **medium** = same working day.

**Where to look**

- Dashboard: CloudWatch → Dashboards → `merchantflo-<env>` (the `stack.dashboard` Terraform output).
- Current gauges: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<api>/v1/admin/ops/metrics`.
- Logs: CloudWatch Logs Insights on `/merchantflo/<env>/api` and `/merchantflo/<env>/worker`.
  Every line is JSON, so `fields @timestamp, msg, err.message | filter level = "error" | sort @timestamp desc`
  works as is.
- Metrics come from the worker's `ops.metrics` log line, once a minute. Every worker replica
  computes the same values from the database; alarms use **Maximum**, never Sum.

---

## Merchant-facing signals (from the worker)

### restricted-window-execution
**Critical.** An AutoPay debit was sent to a PSP inside an NPCI peak window (10:00–13:00 or
17:00–21:30 IST) or a configured blackout. The worker checks the window before every execution, so
this means a bug, a clock problem, or rule-set misconfiguration.
1. Stop executions: `aws ecs update-service --cluster merchantflo-<env> --service merchantflo-<env>-worker --desired-count 0`.
   (Status checks and webhooks stop too; fine for a short while.)
2. Find the attempts (psql via a one-off task, or the dashboard):
   ```sql
   select a.debit_id, a.psp_id, a.created_at at time zone 'Asia/Kolkata' as ist, a.latency_ms, a.outcome
   from payment_attempts a
   where a.op = 'execute' and a.debit_id is not null and a.created_at > now() - interval '1 hour'
   order by a.created_at desc;
   ```
3. Check the task clock (`/health` returns `time`) and `GET /v1/rules` (windows in force).
4. Restore the worker count once the cause is fixed. Tell affected merchants; NPCI may ask the PSP.

### notice-failures
**High.** PSPs are refusing pre-debit notices (`last_error_code = NOTICE_FAILED`); those debits
can't execute on their due date. Common causes: the mandate was cancelled by the customer, the PSP's
notice limits, or a PSP outage. Query `select id, merchant_id, last_psp_id, due_date from debits where last_error_code = 'NOTICE_FAILED' and updated_at > now() - interval '1 hour'`.
If one PSP: check its status page and the `psp-circuit-open` alarm. The worker retries every 15
minutes for 48 hours after the due date, then fails the debit with a `debit.failed` webhook.

### debit-backlog
**High.** Debits due more than 5 minutes ago aren't being picked up, or executions have been stuck
"in flight" for 10+ minutes, for 15 minutes. Is the worker running (see `worker-heartbeat`)? Are
its ticks slow (PSP timeouts — look for long gaps between worker log lines)? Database load (`db-cpu`)?
Stuck EXECUTING rows are reconciled by status lookups automatically after 5 minutes; a growing
number means status checks are failing too. Scale workers up if they're healthy but behind:
`--desired-count 3` (safe: `FOR UPDATE SKIP LOCKED`).

### poller-overdue
**High.** Pending payments' status checks are running late, so customers and merchants wait for
confirmations. Same checks as `debit-backlog`. A single PSP timing out holds checks for up to its
timeout each; `pspCircuitsOpen` tells you which.

### webhook-backlog
**High.** Merchant webhooks are piling up. Usually one merchant's endpoint is slow or down (each
delivery waits up to 10 s): `select merchant_id, count(*) from webhook_outbox where delivered_at is null and dead_at is null group by 1 order by 2 desc`.
Contact the merchant; deliveries retry with backoff and are kept (`GET /v1/webhook-deliveries`,
redeliver later).

### dead-webhooks
**Medium.** A webhook exhausted its 8 retries (or its URL was refused) in the last 24 hours, so a
merchant missed an event. The alarm stays in ALARM while the 24-hour count is above the threshold;
the notification fires once. Tell the merchant; once their endpoint is fixed they (or you)
redeliver from the Developers page or `POST /v1/webhook-deliveries/:id/redeliver`.

### recon-failures
**Medium.** A daily settlement reconciliation failed: `select psp_id, day, error from recon_runs where status = 'FAILED' order by finished_at desc limit 20`.
Usually the PSP's report API (credentials rotated, report not ready). Runs retry on later ticks;
fix credentials via the merchant's PSP connection.

### psp-circuit-open
**High.** A PSP's technical-decline rate tripped its circuit breaker for 10+ minutes; traffic is
failing over to the merchant's other PSPs, or failing where there is none. Check the PSP's status
page, the open ids in `openCircuits` (ops metrics), and `GET /v1/psps/health` per merchant.
Nothing to do inside Merchantflo unless credentials or webhooks are broken; tell merchants with a
single PSP.

### worker-heartbeat
**Critical.** No worker has logged for 6 minutes: no debits, status checks, reconciliation or
webhooks are running. ECS console → service `merchantflo-<env>-worker` → Events and stopped tasks'
reasons. Typical: the task can't start (secret missing, schema behind after a skipped migration —
"database schema is behind this release"), the container health check kills it (heartbeat older
than `WORKER_STALL_MS`), or the database is unreachable.

## API

### api-no-healthy-targets
**Critical.** No api task passes `/readyz`: the API is down for merchants and customers. `/readyz`
fails when a task is shutting down or **can't reach the database** — check `db-*` alarms and the
api log for `readiness: database unreachable`. If tasks aren't running at all, see `tasks-below-desired`.

### api-unhealthy-targets
**Medium.** One api task has failed readiness for 5 minutes (others are serving). ECS replaces
tasks whose container health check fails; if one stays unhealthy, stop it and let ECS start a new one.

### api-5xx
**High.** The API answered more than the threshold of 5xx in 5 minutes. Logs Insights on the api log:
`fields @timestamp, req.url, err.message | filter level = "error" | sort @timestamp desc`. A recent
deploy? Roll back ([deploy runbook](deploy.md#rolling-back)).

### lb-5xx
**High.** The load balancer itself returned 5xx: no healthy targets (502/503) or requests longer than
the 60 s idle timeout (504). See `api-no-healthy-targets`.

### api-latency-p95
**Medium.** API p95 above the threshold for 15 minutes. Usual suspects: database (`db-cpu`, slow
query log in `/aws/rds/instance/merchantflo-<env>/postgresql`), PSP latency on payment creation,
CPU (autoscaling adds tasks at 60% average CPU).

### error-logs
**Medium.** More than the threshold of error-level log lines in 5 minutes (api and worker). Look at
the messages; individual payment failures at PSPs are not errors, so this is worth reading.

## Platform

### tasks-below-desired
**High.** Fewer api or worker tasks running than the minimum for 5 minutes. ECS service → Events:
image pull errors (NAT, ECR), "Cannot start" (missing secret or variable), or failing health checks.

### db-cpu
**Medium.** Database CPU above 80% for 15 minutes. Performance Insights → top SQL. A load spike, a
missing index after a new feature, or the poller/worker batch sizes.

### db-free-storage
**High.** Free storage below the threshold: storage autoscaling may have reached
`db_max_allocated_storage_gb`. Raise it in `infra/envs/<env>/main.tf` and apply.

### db-freeable-memory
**Medium.** Freeable memory below 256 MiB for 15 minutes; consider the next instance size.

### db-connections
**Medium.** Connections above the threshold. Tasks × `DATABASE_POOL_MAX` (default 10) must stay under
the instance's `max_connections`; autoscaled api tasks add connections.

---

## Fire drill

Run before a soak or go-live, and after changing alarms. Two parts:

**1. Notification path, every alarm** — `scripts/drills/alarm-drill.sh <env>` sets each alarm to
ALARM (reason "Fire drill … not a real incident"); each returns to OK at its next evaluation.
Confirm an ALARM and an OK e-mail for every alarm and record the date below.

**2. Real conditions, in staging** — prove the metrics, not just the e-mails:

| Drill | How | Expect |
|---|---|---|
| Worker down | Worker service desired count 0 for 8 minutes, then back to 1 | `worker-heartbeat` ALARM after ~6 min, `tasks-below-desired` (worker); OK after restart |
| Dead webhook | Test merchant whose `webhookUrl` answers 500 (e.g. `https://httpstat.us/500`); create a payment; its 8 attempts run out after about 45 minutes | `dead-webhooks` ALARM |
| API down | API service desired count 0 for 3 minutes | `api-no-healthy-targets`, `lb-5xx` (if probed) |
| PSP circuit | In dev, set `MOCK_PSP_RATES={"pspA":{"bankUnavailable":1}}` (every pspA call is a technical decline) and send test-mode payments | `psp-circuit-open` after 10 min |

| Date | Environment | Part 1 (all alarms notified) | Part 2 drills run | By |
|---|---|---|---|---|
| | | | | |
