# Phase 1 — Correctness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every known correctness and safety gap in the existing system before multi-tenancy and real rails are built on it.

**Architecture:** Targeted fixes inside existing modules; no new subsystems. New outbound webhook events reuse the transactional outbox. Rate limiting uses the official `@fastify/rate-limit` plugin (in-process store; shared store arrives with Phase 5 infrastructure).

**Tech Stack:** existing + `@fastify/rate-limit`.

**Spec:** `docs/roadmap.md` (Phase 1), `docs/regulatory/fact-sheet.md` §2.

## Global Constraints
- No behaviour change to the safety invariants in README "Compliance stance".
- Every fix lands with a test that fails before it.
- Regulatory numbers only in `src/config/rules.ts`.
- New webhook events are additive; existing event payloads keep their fields.

## Review Focus
- A slot computed with < 1 s of window left must not produce `Invalid Date` (Task 1 test: earliest = window end − 60.5 s).
- A mandate execution that errors at PSP A but actually went through must not be sent again via PSP B (Task 2 test).
- An AutoPay debit above ₹15,000 must be refused at intake with a clear reason, not fail at the PSP days later (Task 4 test).
- A merchant webhook URL pointing at a private/link-local address (e.g. cloud metadata 169.254.169.254) must be rejected (Task 7 test).
- One noisy API key must not exhaust the rate limit of another merchant (Task 7 test).

---

### Task 1: Slot picking never divides by zero
**Files:** Modify `src/rules/slots.ts` (`fromPreferred`); Test `test/rules/slots.test.ts`.
- [x] Test: `chooseSlot({ earliest: 16:58:59.5 IST, … })` returns a valid, unrestricted instant (next window), and the sweep stays green.
- [x] Fix: skip a window when `Math.floor(range / 1000) <= 0`.

### Task 2: Status check before failing over a mandate execution
**Files:** Modify `src/routing/router.ts` (`execute`); Test `test/routing/router.test.ts`.
- [x] Tests: mandate PSP_ERROR at A + status SUCCESS at A → success, B untouched; status PENDING → PENDING; NOT_FOUND → fails over to B.
- [x] Fix: apply `confirmBeforeFailover` to every non-timeout technical decline (mandate and collect); out of time → return the decline without failover.
- [x] Update the existing test "leaves mandate failover unchanged" to the new rule.

### Task 3: MDR savings only when the steered payment is paid
**Files:** Modify `src/checkout/service.ts`, `src/api/routes/checkout.ts`, `src/api/schemas.ts`, `src/analytics/value.ts` (method note); Tests `test/api/api.test.ts`, `test/analytics/value.test.ts`.
**Produces:** `CheckoutService.accept(merchantId, quoteId, method)` records the choice only; `CheckoutService.markPaid(merchantId, quoteId, { method, paymentReference })` books `MDR_STEERING_ACCEPTED` once (idempotent) when `method === offer.method`. Route `POST /v1/checkout/quotes/:id/paid`.
- [x] Tests: accept alone books nothing; paid with the offered method books the net saving once; paid with another method books nothing; paid twice is idempotent; paid with a method different from an earlier accept → 409.

### Task 4: AutoPay no-AFA limit enforced at intake
**Files:** Modify `src/config/rules.ts` (`AUTOPAY_NO_AFA_LIMIT_PAISE = 15_000_00`, `AUTOPAY_NO_AFA_MAX_PAISE = 1_00_000_00`), `src/db/schema.ts` + migration `0007` (`mandates.no_afa_limit_paise` nullable), `src/api/schemas.ts`, `src/scheduler/service.ts`, `src/errors.ts` (`AFA_REQUIRED` 422); Test `test/scheduler/scheduler.test.ts`, `test/api/api.test.ts`.
- [x] Tests: ₹15,000 accepted; ₹15,000.01 → `AFA_REQUIRED`; mandate with `noAfaLimitPaise: 1_00_000_00` (eligible category, merchant-declared) accepts ₹50,000; `noAfaLimitPaise` above ₹1 lakh rejected at mandate creation.

### Task 5: Webhook events for what merchants could only see in the dashboard
**Files:** Modify `src/webhooks/outbox.ts` (`WebhookEvent` union), `src/tracking/service.ts`, `src/scheduler/worker.ts`; Create `src/webhooks/payloads.ts` (`paymentIssuePayload`); Tests `test/tracking/poller.test.ts`, `test/scheduler/notice-window.test.ts`, `test/scheduler/scheduler.test.ts`.
**Produces events:** `payment.reversal_initiated`, `payment.reversed`, `payment.captured_after_failure`, `case.needs_action`, `case.resolved`, `debit.notice_sent`, `debit.rescheduled` (with `reason`: `PEAK_WINDOW` | `NOTICE_DATE` | `TECHNICAL_DECLINE` | `NOTICE_DEFERRED`).
- [x] Tests: debited → reversal initiated → completed emits the two reversal events once each; late capture emits `payment.captured_after_failure` once; exhausted verification emits `case.needs_action`; reversal resolution emits `case.resolved`; deferred notice emits `debit.notice_sent`; TD retry emits `debit.rescheduled`.

### Task 6: Status poller checks payments concurrently
**Files:** Modify `src/config/polling.ts` (`concurrency: 8`), `src/tracking/poller.ts`; Test `test/tracking/poller.test.ts`.
- [x] Test: with a slow mock (inquiry latency) and 8 due payments, `runOnce` finishes in ~1 latency, not 8; each payment checked exactly once.

### Task 7: Abuse and SSRF protection
**Files:** Add dependency `@fastify/rate-limit`; Modify `src/api/app.ts`, `src/context.ts` (`rateLimit` options), `src/api/schemas.ts` + `src/webhooks/url.ts` (webhook URL safety), `src/webhooks/outbox.ts` (re-check at delivery: DNS → private address = dead); Tests `test/api/api.test.ts`, `test/webhooks/outbox.test.ts`.
- [x] Tests: per-API-key limit returns 429 with `RATE_LIMITED` and doesn't affect another key; login limited per IP; webhook URLs with private/loopback/link-local hosts or non-https (production) rejected; delivery to a hostname resolving to a private IP is refused.

### Task 8: Windows test-worker crash
**Files:** to be found (systematic debugging): `vitest.config.ts`, test helpers.
- [x] Reproduce the intermittent `0x80000003` worker abort; find the native handle being closed twice; fix or contain; run the suite 10× clean.

### Task 9: Docs
**Files:** `README.md` (new endpoints, events, AFA limit, rate limits), `docs/roadmap.md` (Phase 1 done).
