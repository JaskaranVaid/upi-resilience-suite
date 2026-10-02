# UPI Payment Resilience Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B2B API middleware implementing Engine A (peak-aware AutoPay scheduler), Engine B (MDR quote/steering/marketplace split) and the Phase 2 smart PSP router, with a savings ledger.

**Architecture:** Modular TypeScript monolith. Pure rule functions (`src/rules`) hold all regulatory logic; services orchestrate rules + Postgres (Drizzle; PGlite in dev/test) + PSP adapters; Fastify exposes the API; a Postgres SKIP-LOCKED poller is the job queue.

**Tech Stack:** Node 24, TypeScript 5 (ESM, strict), Fastify 5, Drizzle ORM 0.45, @electric-sql/pglite 0.5, pg, zod 4, Vitest 5, tsx.

**Spec:** `docs/superpowers/specs/2026-10-02-upi-resilience-suite-design.md`

## Global Constraints

- Money is integer paise (`number`, safe up to 9e15) everywhere; DB columns `bigint` mode number.
- All wall-clock reasoning in IST = UTC+05:30 fixed; never use the host timezone.
- Every regulatory number lives in `src/config/rules.ts`, versioned by `effectiveFrom`.
- No method's customer payable may exceed the cart amount (no surcharge).
- Splits only by line-item vendor ownership; one leg per vendor.
- No debit executes inside a peak/blackout window; worker re-checks before execution.
- Timeout → status check before any retry; same `txnRef` on same-PSP retry.
- Services take an injected `Clock` and `sleep`; no direct `Date.now()` outside `src/clock.ts`.
- Errors returned as `{ error: { code, message } }`.

---

### Task 1: Scaffold + IST time & window rules

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/clock.ts`, `src/config/rules.ts`, `src/rules/time.ts`, `src/rules/windows.ts`, `test/rules/windows.test.ts`

**Produces:**
- `Clock { now(): Date }`, `systemClock`, `FakeClock { set(d), advance(ms) }`
- `toIst(d): { y, m, d, minutes }` (minutes since IST midnight), `istDateString(d): 'YYYY-MM-DD'`, `istMidnight(dateStr): Date`, `fromIst(dateStr, minutes): Date`
- `parseHm('10:00'): number`, `inWindow(minutes, w)`, `isRestricted(d, cfg): boolean`
- `RuleSet` type + `getRuleSet(at: Date): RuleSet`

**Tests:** 09:59 IST not restricted; 10:00 restricted; 12:59 restricted; 13:00 not; 21:29 restricted; 21:30 not; blackout 23:45 & 00:15 restricted (midnight wrap); UTC host-independence (construct via UTC ISO strings).

### Task 2: Slot selection

**Files:** Create `src/rules/slots.ts`, `test/rules/slots.test.ts`

**Produces:** `chooseSlot({ earliest: Date, seed: string, cfg: WindowConfig }): Date`, `hashToInt(seed): number`

**Tests:** earliest 10:30 → slot in [13:00,17:00) same day; earliest 18:00 → next day 13:00–17:00; deterministic for same seed; different seeds spread; exhaustive sweep (every 7 minutes for 8 days) → slot ≥ earliest, not restricted, in preferred window.

### Task 3: MDR, steering, split rules

**Files:** Create `src/rules/mdr.ts`, `src/rules/steering.ts`, `src/rules/split.ts`, tests for each.

**Produces:**
- `MerchantProfile { category: MerchantCategory; smallMerchant: boolean }`, `MerchantCategory = 'GENERAL'|'EXEMPT_SECTOR'|'CAPITAL_MARKETS'|'P2P'`
- `computeMdr({ amountPaise, profile, rules }): number`
- `FeeSpec { percentBps; flatPaise; capPaise? }`, `feeFor(amount, spec)`
- `quoteMethods({ amountPaise, profile, rules, methodCosts, steering }): Quote` with `methods: MethodQuote[]`, `offer?: { method, discountPaise, merchantNetSavingsPaise }`
- `splitCart({ lineItems, vendors, rules }): SplitResult` (throws `SplitError`)

**Tests:** each MDR table row; ₹2,000 exactly → 0; ₹2,000.01 → 0.4%; cap ₹300 at ₹75,000+; rounding half-up; pre-effective date → 0; steering offers on ₹5,000 with cheap netbanking; no offer when saving < min; randomized invariant payable ≤ amount & UPI payable == amount & net savings > 0; split groups by vendor, sums, rejects unknown vendor / empty / non-integer.

### Task 4: DB schema + client

**Files:** Create `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `drizzle/` (generated), `test/helpers/db.ts`, `test/db/schema.test.ts`

**Produces:** `createDb({ url?: string }): Promise<{ db: Db; close(): Promise<void> }>` (PGlite in-memory when url undefined or `pglite://...`; node-postgres otherwise); runs migrations. Tables per spec §8.

**Tests:** create db, insert merchant, unique idempotency constraint enforced.

### Task 5: PSP adapter + mock + health + router

**Files:** Create `src/psp/types.ts`, `src/psp/mock.ts`, `src/routing/health.ts`, `src/routing/router.ts`, tests.

**Produces:**
- `PspAdapter`, `PspResult` (spec §6.1)
- `MockPsp(id, { script?: PspResult[]; rates?; latencyMs?; seed? })` with `.calls` log and `.setStatus(txnRef, result)`
- `HealthTracker.record(pspId, result, latencyMs)`, `.rank(ids): string[]`, `.snapshot()`
- `Router.execute({ op: 'mandate'|'collect', candidates, amountPaise, mandateRef?, payerVpa?, baseRef }): Promise<RouteOutcome>` where `RouteOutcome { result: PspResult; attempts: AttemptRecord[]; hadTechnicalDecline: boolean }`

**Tests:** spec §10 router list.

### Task 6: Webhooks outbox + savings ledger

**Files:** Create `src/webhooks/sign.ts`, `src/webhooks/outbox.ts`, `src/ledger/savings.ts`, tests.

**Produces:** `sign(secret, ts, body)`, `enqueueWebhook(tx, merchantId, event, payload)`, `WebhookDispatcher.runOnce()`, `recordSavings(tx, {...})`, `savingsSummary(db, merchantId, from, to)`

### Task 7: Engine A scheduler service + worker

**Files:** Create `src/scheduler/service.ts`, `src/scheduler/worker.ts`, `test/scheduler/*.test.ts`

**Produces:** `SchedulerService.createDebit(merchantId, mandateId, input)`, `DebitWorker.runOnce()`

**Tests:** spec §10 scheduler list.

### Task 8: Engine B checkout service + API + entrypoint

**Files:** Create `src/checkout/service.ts`, `src/api/*.ts`, `src/main.ts`, `src/config/env.ts`, `test/api/*.test.ts`, `README.md`

**Tests:** e2e via `inject`: create merchant (admin), mandate, debit at 10:30 IST; quote; split; payments with failover; savings summary; auth rejection.

### Task 9: Demo script + final verification

**Files:** Create `scripts/demo.ts`. Run full suite, typecheck, demo.
