# Phase 5 — Production Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchantflo runs as Docker images on AWS Mumbai (dev/staging/prod), deployed by a pipeline that migrates the database safely, and is watched by alarms for the failures that matter to merchants.

**Architecture:** One image, four roles (`api`, `worker`, `all`, `migrate`), compiled with `tsc` to `dist/`. Migrations run once per deploy as a one-off ECS task under a Postgres advisory lock; api/worker refuse to start against a database that is behind their code. The worker emits an `ops.metrics` JSON log line every minute (restricted-window executions, notice failures, poller/debit/webhook backlogs, dead webhooks, open PSP circuits, heartbeat); CloudWatch metric filters turn the fields into metrics and alarms page an SNS topic. Terraform (`infra/`) builds VPC, RDS, ECS Fargate, ALB+WAF, KMS/Secrets Manager and monitoring per environment. GitHub Actions builds once and promotes the same image digest staging → production.

**Tech Stack:** existing + Docker (node:22-alpine), Terraform ≥ 1.10 (AWS provider 6.x, S3 native state locking), GitHub Actions OIDC → AWS, AWS CLI in the pipeline. No new runtime npm dependencies.

**Spec:** `docs/roadmap.md` Phase 5; `docs/decisions/0003-hosting-aws-mumbai.md`.

## Global Constraints
- Region `ap-south-1` only; backups, logs and state stay in India (RBI storage rule, decision 0003).
- No secret in git, images or Terraform variables files: secrets come from Secrets Manager (KMS-encrypted) at task start.
- A deploy never runs new code against a database missing its migrations; migrations are expand-only by default (old code keeps working on the new schema), so rollback is "redeploy the previous image".
- The containers run as a non-root user; the image holds no dev dependencies.
- Local development and tests keep PGlite; nothing in Phase 5 needs AWS to develop or test.
- Mock PSPs stay refused in production unless `ALLOW_MOCK_PSPS=true` (staging sets it for test-mode merchants).

## Review Focus
- api and worker containers starting together on a fresh database must not both run migrations (Task 2: advisory lock; api/worker in production don't migrate at all).
- A restricted-window execution (an `execute` attempt on a debit at a peak/blackout time) must show up in the metric even when the debit later succeeded (Task 3 test).
- SIGTERM while requests are in flight: `/readyz` turns 503 first, in-flight requests finish, then the process exits (Task 1 test for readiness during drain).
- Two worker replicas emit the same gauges: alarms use `Maximum`, never `Sum` (Task 5 Terraform; called out in the alarm runbook).
- A deploy whose migration task fails leaves the running services untouched (Task 6 script order: migrate → check exit code → update services).

---

### Task 1: Production build, health probes and process lifecycle
**Files:** `tsconfig.build.json` (rootDir `src`, outDir `dist`); `package.json` scripts `build`, `start:prod`, `db:migrate`, `db:verify`, `check:migrations`; `src/ops/log.ts` (JSON-line logger); `src/ops/lifecycle.ts` (draining flag, heartbeat file); `src/ops/healthcheck.ts` (container health check CLI); `src/api/routes/ops.ts` (`GET /healthz`, `GET /readyz`); `src/main.ts` (drain → close → exit, hard timeout, unhandled rejection handling, structured logs); `src/context.ts` (`log` passed to worker, poller, reconciler, dispatcher); `src/config/env.ts` (new variables).
**Interfaces:** `Lifecycle { draining: boolean; beginDrain(): void }` on `AppContext.lifecycle`; `writeHeartbeat(file)`, `heartbeatAge(file, now)`; `logger.info/warn/error(msg, fields?)`.
**Tests:** `test/ops/lifecycle.test.ts` — `/healthz` 200 without DB work; `/readyz` 200 normally, 503 `{status:'draining'}` after `beginDrain()`; heartbeat age; healthcheck decides by role.

### Task 2: Migration-aware database
**Files:** `src/db/migrate.ts` (`migrateDatabase(url)` — pg: advisory lock `pg_advisory_lock(7_221_998_431)` on a dedicated client; PGlite: plain; `schemaStatus(db)` → `{ expected, applied, upToDate }` from `drizzle/meta/_journal.json` vs `drizzle.__drizzle_migrations`); `src/db/client.ts` (`createDb(url, { migrate, poolMax })`); `ROLE=migrate` in `main.ts` (migrate and exit 0); env `MIGRATE_ON_START` (default true except production) and `DATABASE_POOL_MAX`; `scripts/check-migrations.ts` (migrations after `0016` may not `DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL` or add `NOT NULL` columns without default unless the file carries `-- merchantflo:contract <reason>`); CI step; `docs/decisions/0007-expand-contract-migrations.md`.
**Tests:** `test/db/migrate.test.ts` — status up to date after migrate; behind after deleting the last applied row; startup refuses with a clear message when behind and `migrate:false`; `test/db/check-migrations.test.ts` — each forbidden statement flagged, marker allows, baseline files ignored.

### Task 3: Operational metrics
**Files:** `src/ops/metrics.ts` (`collectOpsMetrics({ db, clock, health })`), emitter in the worker loop on its own timer (`OPS_METRICS_INTERVAL_MS`, default 60 000; 0 = off); `GET /v1/admin/ops/metrics` (admin token); OpenAPI entry.
**Metrics** (all gauges, computed from the database so replicas agree):
`restrictedWindowExecutions` (execute attempts on debits in the last 15 min whose time is restricted by the rule set in force then), `noticeFailures` (debits whose last error is `NOTICE_FAILED`, touched in the last hour), `debitBacklog` (SCHEDULED/PENDING_CONFIRMATION due > 5 min ago, plus EXECUTING untouched > 10 min), `pollerBacklog` and `pollerOldestOverdueSeconds` (IN_PROGRESS checks due > 5 min ago), `webhookBacklog` (undelivered, not dead, due > 5 min ago), `deadWebhooks24h`, `reconFailures24h`, `pspCircuitsOpen` (+ `openCircuits` ids), `workerHeartbeat` = 1.
**Tests:** `test/ops/metrics.test.ts` — one test per metric with seeded rows, including a restricted-window execute attempt on a debit that later SUCCEEDED, status attempts ignored, and old rows outside the lookback ignored; admin route requires the admin token.

### Task 4: Docker image and local production stack
**Files:** `Dockerfile` (multi-stage: deps → build → runtime `node:22-alpine`, `npm ci --omit=dev`, RDS CA bundle at `/etc/ssl/certs/rds-global-bundle.pem`, user `node`, `HEALTHCHECK` via `dist/ops/healthcheck.js`, `CMD node dist/main.js`); `.dockerignore`; `docker-compose.yml` (postgres:16, `migrate` one-shot, `api`, `worker`); `scripts/compose-smoke.sh` (readyz → onboard a merchant → authenticated call → ops metrics); CI job `docker` (build + compose smoke).
**Verify:** `docker compose up -d --build --wait` then `bash scripts/compose-smoke.sh` passes locally.

### Task 5: Terraform for AWS Mumbai
**Files:** `infra/bootstrap/` (state bucket with KMS + versioning, GitHub OIDC provider, ECR repo `merchantflo` immutable + scan on push + lifecycle, build role and per-environment deploy roles); `infra/modules/network` (VPC, 3 AZs, public/app/db subnets, NAT per env sizing, S3 gateway endpoint, flow logs); `infra/modules/data` (KMS key, RDS PostgreSQL 16 Multi-AZ toggle, `rds.force_ssl`, PITR backups, deletion protection, Performance Insights, Secrets Manager secrets: `DATABASE_URL`, `ADMIN_TOKEN`, `CUSTOMER_TOKEN_SECRET`, `CREDENTIALS_KEYS` placeholder); `infra/modules/service` (ECS cluster, task definitions api/worker/migrate, services with circuit-breaker rollback, autoscaling, IAM, log groups, security groups); `infra/modules/edge` (ALB, HTTPS listener with ACM cert, HTTP→HTTPS, target group on `/readyz`, WAFv2 managed rules + per-IP rate rule, access logs bucket); `infra/modules/monitoring` (SNS + email, metric filters for every `ops.metrics` field, alarms, dashboard); `infra/stack` (composition); `infra/envs/{dev,staging,prod}`; `infra/README.md`; CI job `infra` (`terraform fmt -check -recursive`, `init -backend=false`, `validate` per env).
**Alarms:** restricted-window executions > 0; notice failures ≥ threshold; debit, poller and webhook backlogs; dead webhooks > 0; recon failures > 0; PSP circuit open ≥ 10 min; worker heartbeat missing (missing data = breaching); ALB 5xx rate, p95 latency, unhealthy hosts; RDS CPU, free storage, connections; ECS running tasks below desired.
**Verify:** `terraform fmt -check -recursive infra` and `terraform validate` in each env and bootstrap.

### Task 6: Deploy pipeline
**Files:** `.github/workflows/deploy.yml` (after CI succeeds on `main`: build once, push `merchantflo:<sha>`, deploy staging; `workflow_dispatch` promotes a tag to production behind the `production` environment's required reviewers; whole workflow off until repo variable `DEPLOY_ENABLED=true`); `scripts/deploy/task-def.ts` (`renderTaskDefinition(current, image)` strips read-only fields and swaps the `app` image); `scripts/deploy/ecs-deploy.sh` (register api/worker/migrate revisions → run migrate task in the service's network → exit code 0 or abort → update services → `services-stable` → smoke `/readyz`).
**Tests:** `test/ops/task-def.test.ts` — read-only fields removed, only the `app` container's image changes, other containers untouched, missing `app` container throws.

### Task 7: Load tests, restore drill, alarm drill
**Files:** `scripts/load/stats.ts` (percentiles, summary, threshold check); `scripts/load-test.ts` (onboards N test-mode merchants with a mock connection, then runs a weighted mix — checkout sessions, payments, mandate + debit intake, reads — at a target rate for a duration; prints throughput, p50/p95/p99, errors, 429s; exits 1 on breach of `LOAD_P95_MS`/`LOAD_MAX_ERROR_RATE`); `src/ops/verify.ts` (`verifyDatabase(db)`: schema status, row counts, invariants — terminal debits have `completed_at`, an outbox row is never both delivered and dead, succeeded payments have a PSP); `src/ops/verify-cli.ts` (`VERIFY_DATABASE_HOST` swaps the host in `DATABASE_URL`, never migrates); `scripts/drills/restore-drill.sh` (PITR restore → verify task → timings → delete); `scripts/drills/alarm-drill.sh` (each alarm set to ALARM with reason "fire drill").
**Tests:** `test/ops/load-stats.test.ts`; `test/ops/verify.test.ts` — clean database passes, each invariant violation reported.

### Task 8: Runbooks and docs
**Files:** `docs/runbooks/{deploy.md,alerts.md,backup-restore.md,load-testing.md}`; `infra/README.md`; README (production section, roles, new env vars); `.env.example`; `docs/roadmap.md` (Phase 5 ✅ code); `docs/roadmap/external-actions.md` (AWS account + bootstrap, domain and ACM certificate, alarm e-mail, GitHub environments and variables, 7-day staging soak, fire drill, restore drill, load test sign-off).
