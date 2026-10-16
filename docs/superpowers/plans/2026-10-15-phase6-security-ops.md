# Phase 6 — Security, Compliance and Internal Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchantflo can be trusted with real customers' data and stopped instantly: scanned dependencies and secrets, two-factor operator access, encrypted customer identifiers with retention and erasure, and a kill switch that pauses money movement globally, per merchant or per PSP.

**Architecture:** Security gates run in CI (npm audit, CodeQL, gitleaks, Trivy). Merchantflo staff use a separate **ops console** (`/ops/`) with their own accounts that always require a TOTP code; merchant dashboard users can turn TOTP on. The **kill switch** is a small `execution_pauses` table consulted by the worker (no new executions or notices for paused scopes), the router (paused PSPs are skipped) and payment creation (paused merchants/global → 503). Customer VPAs and phone numbers are sealed in the database by a drizzle column type (AES-256-GCM, key ring derived from `CREDENTIALS_KEYS`), transparently on read/write; a retention job redacts them after a configurable period and merchants can erase a data principal on request.

**Tech Stack:** existing; TOTP (RFC 6238) on `node:crypto`; GitHub CodeQL, gitleaks and Trivy actions. No new runtime npm dependencies (`@fastify/static` upgraded to 10.1.6 for GHSA-pr96-94w5-mx2h et al.).

**Spec:** `docs/roadmap.md` Phase 6.

## Global Constraints
- The kill switch never cancels or fails anything: paused debits stay SCHEDULED and run (with a fresh pre-debit notice if their date passed) once lifted; status checks, reconciliation and webhooks keep running while paused.
- Operator (Merchantflo staff) access always needs password + TOTP; ADMIN_TOKEN stays for automation only.
- Personal fields (customer VPA, payer VPA, customer phone, the collect action's VPA) are never stored in plaintext once encryption is on; old plaintext rows stay readable and are sealed by a backfill.
- Every operator action (pause, lift, erasure) is audited with who, when and why.
- Migrations stay expand-only (decision 0007).

## Review Focus
- A debit already claimed (EXECUTING) when a global pause starts must finish safely; a SCHEDULED debit must not be claimed while paused (Task 3 tests).
- A pause on one merchant must not stop another merchant's debits or payments (Task 3 test).
- Encrypted fields must round-trip through every write path (create, idempotent replay comparison, `.returning()`), and a row written before encryption must still read correctly (Task 6 tests).
- Erasure must touch only the requesting merchant's records (Task 7 test).
- TOTP codes must be single-use within their window (replay of the code just used is refused) (Task 2 test).

---

### Task 1: Security gates and headers
**Files:** `package.json` (`@fastify/static` ^10.1.6); `.github/workflows/ci.yml` (`npm audit --omit=dev --audit-level=high`; Trivy scan of the built image, HIGH/CRITICAL fixed vulns fail); `.github/workflows/codeql.yml`; `.github/workflows/secrets.yml` (gitleaks on push/PR); `src/api/app.ts` (`strict-transport-security` when served over HTTPS in production, `x-content-type-options: nosniff` on every response, `cache-control: no-store` on `/v1` responses); `SECURITY.md`.
**Tests:** `test/api/security-headers.test.ts`; existing static tests pass on the new `@fastify/static`.

### Task 2: TOTP and operator accounts
**Files:** `src/auth/totp.ts` (`generateSecret()`, `totpCode(secret, at)`, `verifyTotp(secret, code, at, lastUsedStep)` → step or null, ±1 step, `otpauthUri(...)`); schema + migration: `operators` (email, name, password_hash, totp_secret sealed, totp_last_step, role `OWNER|OPERATOR|VIEWER`, disabled, failed_logins, locked_until, last_login_at), `operator_sessions`, `operator_audit`; `src/ops-console/operators.ts` (`OperatorService`: create, login(email, password, code) with lockout and replay refusal, authenticate(token), logout, audit); `scripts/ops-operator.ts` CLI (`create` prints a one-time password and the otpauth URI; `reset-2fa`; `disable`).
**Tests:** `test/auth/totp.test.ts` (RFC 6238 test vectors, window, replay), `test/ops-console/operators.test.ts` (wrong code, lockout, disabled, session expiry, sealed secret at rest).

### Task 3: Kill switch
**Files:** schema + migration `execution_pauses` (scope `GLOBAL|MERCHANT|PSP`, target, reason, created_by, created_at, lifted_at, lifted_by); `src/ops-console/pauses.ts` (`ExecutionControl`: `pause`, `lift`, `active()`, `isMerchantPaused(merchantId)`, `pausedPsps()`); `src/scheduler/worker.ts` (claim skips SCHEDULED debits of paused merchants / all when global); `src/routing/router.ts` (paused PSPs dropped from candidates for execute/collect, status unaffected); `src/payments/service.ts` + checkout pay (503 `EXECUTION_PAUSED`); ops API `GET/POST /ops/api/pauses`, `POST /ops/api/pauses/:id/lift`; `executionPausesActive` in ops metrics + Terraform metric filter + alarm `execution-paused` (≥ 1 for 30 min).
**Tests:** `test/ops-console/kill-switch.test.ts`: global pause stops new executions and payment creation, keeps confirmations; merchant pause isolates; PSP pause fails over; lift resumes with a new notice when the date passed; audit rows.

### Task 4: Ops console UI
**Files:** `ops/index.html`, `ops/app.js`, `ops/styles.css` (login with code; pauses: list, create, lift; ops metrics; audit log); static serving at `/ops/` with the dashboard's CSP; ops API: `POST /ops/api/login`, `POST /ops/api/logout`, `GET /ops/api/me`, `GET /ops/api/metrics`, `GET /ops/api/audit`; CSRF header and rate limits as the dashboard.
**Tests:** `test/ops-console/ops-api.test.ts` (auth required, VIEWER can't pause, CSRF header), static test; browser check.

### Task 5: Dashboard two-factor (optional per user)
**Files:** migration: `dashboard_users.totp_secret`, `totp_last_step`; `SessionService.login(email, password, code?)` (returns `MFA_REQUIRED` when enabled and no/invalid code); `POST /dashboard/api/me/2fa/setup` (secret + otpauth + QR SVG, pending), `POST /dashboard/api/me/2fa/confirm {code}`, `POST /dashboard/api/me/2fa/disable {password, code}`; dashboard login asks for the code; a Security section in the Users view.
**Tests:** `test/auth/dashboard-2fa.test.ts`.

### Task 6: Field encryption
**Files:** `src/security/fields.ts` (`configureFieldEncryption({ box, enabled })`, `personalText(name)` and `personalJson(name)` drizzle column types; sealed values prefixed `pf1.`; plaintext rows read as-is); `SecretBox.derive(purpose)` (HKDF per key id); schema uses them for `mandates.customer_vpa`, `payments.payer_vpa`, `payments.customer_action`, `checkout_sessions.customer_phone|customer_vpa`; env `ENCRYPT_PERSONAL_FIELDS` (default true); `scripts/privacy-backfill.ts` (`npm run privacy:backfill` seals plaintext rows in batches).
**Tests:** `test/security/fields.test.ts` (sealed at rest via raw SQL, round trip through API create + idempotent replay, legacy plaintext readable, backfill seals, disabled mode writes plaintext, key rotation).

### Task 7: Retention and erasure (DPDP)
**Files:** `src/privacy/service.ts` (`PrivacyService.purgeExpired(now)`: redact personal fields of payments/sessions finished more than `PERSONAL_DATA_RETENTION_DAYS` (default 180) ago and of inactive mandates without recent debits; delete delivered/dead webhook log rows older than `WEBHOOK_LOG_RETENTION_DAYS` (default 30) and expired sessions; `erase(merchantId, { vpa?, phone? }, actor)` redacts matching records of that merchant and webhook payloads, returns counts); worker runs `purgeExpired` daily (throttled); `POST /v1/privacy/erasure` (merchant API key) and `POST /ops/api/privacy/erasure`; events `DATA_ERASED`, `DATA_RETENTION_PURGED`.
**Tests:** `test/privacy/privacy.test.ts` (retention boundaries, active mandate kept, erasure scoped to merchant, webhook payload redacted, audit).

### Task 8: Threat model, legal drafts, runbooks
**Files:** `docs/security/threat-model.md` (STRIDE by trust boundary with mitigations and residual risks), `docs/security/pentest-scope.md`; `docs/legal/{privacy-notice,dpa,retention-policy,subprocessors}.md` (drafts for counsel); `docs/runbooks/{kill-switch,incident-response,operators}.md`; README, `.env.example`, roadmap (Phase 6 ✅ code), external actions (pen test, counsel review of legal drafts, first operator accounts, kill-switch drill).
