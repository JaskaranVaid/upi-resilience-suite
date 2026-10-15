# Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish regulatory ground truth, record the decisions later phases depend on, make the MDR start date configuration, and set up CI and repo hygiene.

**Architecture:** Documentation under `docs/` (fact sheet, ADRs, roadmap, external actions); one code change in `src/config/rules.ts` replacing the hard-coded MDR rule set with a configured start date; GitHub Actions CI.

**Tech Stack:** existing (Node ≥ 22, TypeScript, Vitest); GitHub Actions.

**Spec:** `docs/roadmap.md` (Phase 0).

## Global Constraints
- No regulatory value without a cited source in `docs/regulatory/fact-sheet.md`.
- Unset `MDR_EFFECTIVE_FROM` = MDR not in force (no fee quoted, no steering, no MDR savings).
- Wire identifiers (webhook headers, cookie, id prefixes) are not renamed.
- Commits authored by the founder; no tool/AI attribution.

## Review Focus
- Server started without `MDR_EFFECTIVE_FROM` → `/v1/rules` says `NOT_SCHEDULED`, quotes carry no MDR. (Task 1 test)
- Postponed start date → `SCHEDULED` before, `IN_FORCE` from that IST midnight. (Task 1 test)
- Malformed `MDR_EFFECTIVE_FROM` → startup fails with a clear message (zod regex + `configureMdrEffectiveFrom` throws). (Task 1 test)
- Existing scenario tests keep the announced 15 Oct 2026 date via `test/setup.ts`, so they don't silently lose MDR coverage.
- Windows checkouts produce LF files (`.gitattributes`), so CI diffs don't churn.

---

### Task 1: MDR start date as configuration
**Files:** Modify `src/config/rules.ts`, `src/config/env.ts`, `src/main.ts`, `src/api/routes/ops.ts`, `scripts/demo.ts`, `scripts/demo-dashboard.ts`, `.env.example`, `vitest.config.ts`; Create `test/setup.ts`; Test `test/rules/windows.test.ts`, `test/api/api.test.ts`, rule tests.
**Produces:** `MDR_2026: MdrRules`, `LEGACY_RULE_SET`, `MDR_RULE_SET_ID = 'npci-mdr-2026'`, `configureMdrEffectiveFrom(date: string | Date | null)`, `getMdrEffectiveFrom()`, `ruleSets(): RuleSet[]`, `mdrStatus(at): { status: 'NOT_SCHEDULED'|'SCHEDULED'|'IN_FORCE'; effectiveFrom }`; `GET /v1/rules` adds `mdrRegime`.
- [x] Tests: default null → zero MDR + `NOT_SCHEDULED`; postponed date → `SCHEDULED`/`IN_FORCE`; invalid date throws; `/v1/rules` reports status.
- [x] Implement, typecheck, full suite, commit.

### Task 2: Regulatory fact sheet
**Files:** Create `docs/regulatory/fact-sheet.md` — MDR, AutoPay windows and no-AFA limit, collect restrictions, mandate portability, our regulatory position; each row with confidence and source link.
- [x] Write and commit.

### Task 3: Decision records
**Files:** Create `docs/decisions/README.md`, `0001`–`0006`.
- [x] Write and commit.

### Task 4: Roadmap and external actions
**Files:** Create `docs/roadmap.md`, `docs/roadmap/external-actions.md` (owners, templates for Cashfree and counsel).
- [x] Write and commit.

### Task 5: CI and repo hygiene
**Files:** Create `.github/workflows/ci.yml` (Node 22 + 24: `npm ci`, typecheck, test), `.github/pull_request_template.md` (payments safety checklist), `.github/dependabot.yml`, `.gitattributes` (LF).
- [x] Renormalise line endings in a separate commit; add CI files; commit.

### Task 6: Naming
**Files:** `README.md`, `package.json`, `package-lock.json`, `dashboard/index.html`, `dashboard/app.js`, `dashboard/views/login.js`.
- [x] Rename user-facing strings to Merchantflo; full suite; commit.
