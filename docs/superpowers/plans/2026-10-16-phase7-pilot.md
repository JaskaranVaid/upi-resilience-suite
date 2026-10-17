# Phase 7 — Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pilot merchant moves from shadow (we plan, they execute) to a canary slice of mandates to 100%, with every pass criterion — zero double debits, zero restricted-window executions, measurable AutoPay uplift, ≥ 99.9% webhooks within 5 minutes, statement reconciles to settlement — measured by the product itself.

**Architecture:** A per-merchant rollout stage (`SHADOW | CANARY p% | FULL`) decides at intake who executes each debit; canary assignment hashes the mandate id. Shadow debits are planned with the live planner but stored in their own table that nothing executes. Merchants report legacy outcomes (or a historical export) to `POST /v1/pilot/executions`; a shadow report classifies them conservatively, a duplicate detector pairs Merchantflo executions with any other success on the same mandate, and a scorecard evaluates the five criteria and gates the move to FULL.

**Tech Stack:** existing (Fastify, Drizzle, Postgres/PGlite, zod, vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-phase7-pilot-design.md`.

## Global Constraints
- Merchants not in a pilot behave exactly as before: default stage FULL, every existing test passes unchanged.
- Nothing reads `shadow_debits` to move money: no notice, no PSP call, no worker claim.
- One idempotency key → at most one debit across live and shadow (advisory lock + cross-check).
- Value claims are conservative: potential value is labelled and never summed into certain value; UNKNOWN failure causes are never credited.
- Rollbacks affect new requests only; debits already promised to the merchant as MERCHANTFLO still run.
- Migrations stay expand-only (ADR 0007).

## Review Focus
- A shadow debit can never be claimed by the worker or reach a PSP (Task 3 test drives the worker over shadow rows).
- Concurrent requests with one key around a stage change create exactly one debit (Task 3 test).
- A misrouted report hands back a SCHEDULED live debit atomically and never touches one already EXECUTING (Task 4 tests).
- Canary assignment is deterministic and monotonic in the percentage (Task 2 test).
- Scorecard maths: Newcombe interval against published values; webhook and reconciliation edge cases (Tasks 5, 7 tests).

---

### Task 1: Schema
**Files:** `src/db/schema.ts` — `merchants.rollout_stage` (`RolloutStage`, default `FULL`), `merchants.canary_percent` (nullable); `rollout_changes`; `debits.rollout_stage` (nullable); `shadow_debits` (unique merchant+idempotency key; indexes by merchant+executed_at, merchant+mandate_ref+executed_at, merchant+created_at); `duplicate_suspects` (unique pair); migration `0021_pilot.sql` via drizzle-kit.
**Tests:** `npm run check:migrations`; `test/db/schema.test.ts` still passes; migration applies on PGlite.

### Task 2: Rollout stages and canary assignment
**Files:** `src/pilot/rollout.ts` — `canaryBucket(mandateId)`, `executorFor(stage, percent, mandateId)`, `RolloutService` (`get`, `history`, `change(merchantId, {stage, canaryPercent, reason, override}, actor)` with validation, history row, operator audit, `pilot.stage_changed` webhook; gates plugged in by Task 7), `startShadowOnFirstLive(tx, merchant)`; `src/webhooks/outbox.ts` event type; admin mode change calls it; `GET /v1/pilot`.
**Tests:** `test/pilot/rollout.test.ts`: bucket stable and uniform-ish, monotonic percentage; change history/audit/webhook; invalid percent; first LIVE switch → SHADOW, second does not reset; TEST merchant stays FULL.

### Task 3: Debit intake and shadow debits
**Files:** `src/pilot/shadow.ts` (`ShadowService.createFromIntake`, `get`, `list`, `shadowDebitView`); `src/pilot/intake.ts` (`DebitIntake.request`: live replay → shadow replay → executor → create); `src/pilot/keys.ts` (`lockDebitKey(tx, merchantId, key)`); `SchedulerService.createDebit` takes `rolloutStage` and, in its insert transaction, locks the key and refuses if a shadow row holds it; `debitView` gains `executedBy`; mandate responses gain `executedBy`; routes `GET /v1/shadow-debits`, `GET /v1/shadow-debits/:id`; responses + OpenAPI.
**Tests:** `test/pilot/intake.test.ts`: SHADOW stage returns `executedBy: MERCHANT`, sends no notice, worker never touches it across days; CANARY splits by bucket; FULL unchanged; replay across a stage change returns the original kind; key conflict; concurrent same-key requests → one row; `wouldRefuse` recorded instead of an error; existing scheduler tests untouched.

### Task 4: Reported executions
**Files:** `src/pilot/executions.ts` (`ExecutionReports.report(merchantId, items)` chunked; CSV mapping); `DebitWorker.handBack(merchantId, debitId)` (conditional SCHEDULED → FAILED `EXECUTED_BY_MERCHANT`, webhook, events, tracking); route `POST /v1/pilot/executions` (JSON + `text/csv`).
**Tests:** `test/pilot/executions.test.ts`: outcome recorded/updated; backtest row planned at requestedAt; conflicts (mandateRef/amount differ); validation (future time, missing fields); misrouted SCHEDULED live debit handed back with webhook and never executed; misrouted EXECUTING debit left alone and flagged as misrouted; CSV path.

### Task 5: Shadow report
**Files:** `src/pilot/classify.ts` (pure `classifyShadow(row, rules)`), `src/pilot/report.ts` (`ShadowReportService.summary(merchantId, period)`, `rowsCsv`), `src/pilot/stats.ts` (Wilson interval, Newcombe difference), measured recovery rate from live debits; `AUTOPAY_PEAK_RULE_FROM` in `src/config/rules.ts`.
**Tests:** `test/pilot/classify.test.ts` (every class, peak-rule start date, boundaries); `test/pilot/stats.test.ts` (Newcombe 2001 worked examples); `test/pilot/report.test.ts` (totals, estimate only with live data, coverage, CSV).

### Task 6: Double-debit detector
**Files:** `src/pilot/duplicates.ts` (`DuplicateDetector.runDue/scan/list/resolve`); worker tick in `src/main.ts`; `duplicateDebitsOpen` in `src/ops/metrics.ts`; Terraform metric filter + alarm `duplicate-debit-suspected`; alerts runbook entry.
**Tests:** `test/pilot/duplicates.test.ts`: live+reported same mandate/amount < 24 h → one suspect (idempotent rescans); different amount or > 24 h → none; legacy+legacy → none; live+live → suspect; resolve CONFIRMED/DISMISSED audited; gauge; infra test covers the alarm.

### Task 7: Scorecard and gates
**Files:** `src/pilot/scorecard.ts` (`PilotScorecard.evaluate(merchantId, period)` — five criteria); `restrictedExecutions(db, {from, to, merchantId})` shared with `src/ops/metrics.ts`; gates in `RolloutService.change` (forward to CANARY: webhook URL, LIVE → active production connection, no open suspects; forward to FULL: criteria 1, 2, 4, 5 pass over the canary period, ≥ 7 days, ≥ 30 final canary debits; OWNER override with reason); routes `GET /v1/pilot/scorecard`, `GET /v1/pilot/report`.
**Tests:** `test/pilot/scorecard.test.ts`: each criterion PASS/FAIL/PENDING/NO_DATA; webhook threshold and young-pending exclusion; reconciliation mismatch/overdue/unverifiable; uplift arms by rollout stage; `test/pilot/gates.test.ts`: refusals with reasons, override by OWNER only, rollback always allowed.

### Task 8: Ops console — pilots and duplicates
**Files:** `src/api/ops-pilots.ts` (`GET /ops/api/pilots`, `GET /ops/api/pilots/:merchantId`, `POST /ops/api/pilots/:merchantId/stage`, `GET /ops/api/pilots/:merchantId/report.csv`, `GET /ops/api/duplicates`, `POST /ops/api/duplicates/:id/resolve`); `ops/app.js` (Pilots list + detail, Duplicates queue, metric tile), `ops/styles.css`.
**Tests:** `test/ops-console/pilots-api.test.ts` (auth, roles, override needs OWNER, CSRF); static test; browser check of the views.

### Task 9: Merchant surfaces — dashboard, OpenAPI, SDK
**Files:** `src/api/dashboard/analytics.ts` (`/dashboard/api/pilot`, `/dashboard/api/pilot/report.csv`), meta gains `pilot`; `dashboard/views/analytics.js` Pilot tab, `dashboard/api/client.js`; OpenAPI entries + response schemas; SDK (`Debit.executedBy`, `ShadowDebit`, `pilot.get/scorecard/report/reportExecutions`, `shadowDebits.retrieve/list`, webhook event type).
**Tests:** dashboard API test; OpenAPI "documents every route" passes; SDK test for the new calls; browser check of the Pilot tab.

### Task 10: Documents
**Files:** `docs/decisions/0008-pilot-rollout-by-mandate.md` + index; `docs/runbooks/pilot.md`; `docs/integration-guide.md` (pilot section); `docs/legal/pilot-terms.md`; `docs/roadmap/external-actions.md` (#25–#30); `docs/roadmap.md` (Phase 7 ✅ code); `README.md`; `docs/legal/retention-policy.md` (shadow rows); alerts runbook.
**Tests:** full suite, typecheck, build, check:migrations.
