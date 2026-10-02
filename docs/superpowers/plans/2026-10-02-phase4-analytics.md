# Phase 4 — Value & Revenue-Recovery Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the suite's value per merchant per billing cycle: value delivered, success uplift, PSP performance, payment issues, monthly statement.

**Architecture:** Read-only `src/analytics/` services over existing tables (savings_events, payment_attempts, payment_tracking, payment_cases, udir_complaints, merchant_payments_v); thin `/dashboard/api/analytics` routes; vanilla-JS views with hand-rolled SVG charts.

**Tech Stack:** unchanged (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-10-02-phase4-analytics-design.md`

## Global Constraints
- Phases 1–3 behaviour unchanged except gap fix 1 (adds a previously-missed `TD_RECOVERED` credit).
- Every value line has a backend-supplied method note; no industry statistics shown as merchant data.
- Labels: "steering" (never "bypass"), "captured" (never "settled"); no raw PSP codes.
- All roles read analytics; every query scoped by merchant.
- CSV exports are formula-injection safe.
- Each task ends with typecheck + full suite green, then commit.

### Task 1: Gap fixes
Files: `src/tracking/service.ts`, `src/db/schema.ts`, `drizzle/0003_*.sql`; tests in `test/tracking/poller.test.ts`.
Test: collect TIMEOUT→PENDING→poller SUCCESS records `TD_RECOVERED`; PENDING-without-TD success records nothing.

### Task 2: Periods + value summary + success uplift
Files: `src/analytics/period.ts`, `src/analytics/value.ts`; tests `test/analytics/period.test.ts`, `test/analytics/value.test.ts`.

### Task 3: PSP performance
Files: `src/analytics/psps.ts`; test `test/analytics/psps.test.ts`.

### Task 4: Payment-issue analytics
Files: `src/analytics/issues.ts`; test `test/analytics/issues.test.ts`.

### Task 5: Statement + CSV exports
Files: `src/analytics/csv.ts`, `src/analytics/statement.ts`; test `test/analytics/statement.test.ts`.

### Task 6: Analytics API
Files: `src/api/dashboard/analytics.ts`, `src/context.ts`, `src/api/dashboard/plugin.ts`; test `test/api/analytics.test.ts` (roles, isolation, periods, CSV headers).

### Task 7: Frontend (load the dataviz skill first)
Files: `dashboard/components/charts.js`, `dashboard/views/analytics.js`, `dashboard/app.js`, `dashboard/api/client.js`, `dashboard/styles.css` (+ print styles).

### Task 8: Demo, docs, verification
Files: `scripts/demo-dashboard.ts` (spread seeded value/attempts over the month), `README.md`.
Verify: typecheck, full suite, `npm run demo`, browser walkthrough (all tabs, light/dark, phone width, print preview).
