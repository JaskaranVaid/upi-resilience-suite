# Real PSP Integration — Cashfree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A production-grade Cashfree adapter behind the existing PSP contract, plus the contract and scheduler changes real providers need.

**Spec:** `docs/superpowers/specs/2026-10-03-real-psp-cashfree-design.md`

## Global Constraints
- Mock-only deployments behave exactly as before (all existing tests stay green).
- No secret is logged or persisted; credentials only from env.
- Every Cashfree POST is idempotent by construction (deterministic `x-idempotency-key`).
- Unknown provider statuses never trigger a retry.
- Each task ends with typecheck + full suite green, then a commit.

### Task 1: Adapter contract v2
Capabilities, `TxnContext` on `status`/`inquire`, `noticeRef` on `executeMandate`, `customerPhone` on
`collect`, mode `SANDBOX`. Update MockPsp, Router (pass ctx), worker confirm, tracking inquire,
dispute eligibility (`udirComplaints`), query detail + dashboard label for SANDBOX.
Tests: router passes ctx to status; eligibility blocks when unsupported; existing suite green.

### Task 2: Scheduler — provider notice window, deferred notice, mandate portability
`plan()` takes provider min notice; intake defers notice beyond `maxNoticeLeadMs`; migration makes
notice columns nullable; worker sends deferred notices; mandate creation validates portability.
Tests: 25 h minimum honoured; due date 20 days out → deferred then notified 6 days before; mock unchanged;
non-portable mixing rejected; default eligible = portable PSPs.

### Task 3: HTTP client + Cashfree adapter
`src/psp/http.ts` (timeout, JSON, typed errors), `src/psp/cashfree/{client,adapter,mapping}.ts`.
Contract tests against a fake Cashfree server (`test/psp/cashfree.test.ts`): exact paths, headers,
bodies, idempotency keys, amounts, every mapping row in spec D4/D5.

### Task 4: Webhooks
Raw-body route `POST /webhooks/psp/:pspId`, signature + timestamp verification, reference extraction,
recheck scheduling. Tests: valid/invalid/stale signatures, unmatched refs, recheck triggered, no state
change from payload.

### Task 5: Configuration & wiring
Env (`CASHFREE_*`), adapter construction in `main.ts`, `customerPhone` on `POST /v1/payments`
(required when a configured PSP needs it), README/runbook.

### Task 6: Sandbox smoke script & verification
`scripts/cashfree-sandbox-smoke.ts` (skips without credentials), docs, full suite, demos.
