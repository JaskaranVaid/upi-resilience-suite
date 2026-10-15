# Phase 2 — Multi-tenant Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every merchant runs on its own PSP accounts (ADR 0002), in an explicit test or live mode, with self-managed API keys, settings and bulk mandate import.

**Architecture:** A `psp_connections` table holds each merchant's provider accounts with AES-256-GCM-encrypted credentials. The connection id *is* the PSP id everywhere (mandates.eligible_psps, payments.psp_id, attempts, tracking, health), so routing, tracking and analytics need no new concepts. A single async `PspRegistry` resolves ids: the merchant's connections (adapter built from decrypted credentials, cached) plus process-level "shared" adapters (mocks, a platform sandbox account) that only TEST-mode merchants may use. `Router`, scheduler, tracking, disputes and queries resolve adapters through it.

**Tech Stack:** existing; `node:crypto` AES-256-GCM (no new dependency).

**Spec:** `docs/roadmap.md` Phase 2; `docs/decisions/0002-merchants-own-psp-accounts.md`.

## Global Constraints
- Credentials are encrypted at rest and never logged, returned by an API, or included in errors.
- A LIVE merchant can use only its own LIVE (production) connections; shared adapters and sandbox/mock connections are TEST-only.
- A TEST merchant can never reach a production PSP endpoint.
- Existing behaviour for TEST merchants with shared mock adapters is unchanged (the existing suite stays green).
- API keys: `sk_test_…` / `sk_live_…`, stored as SHA-256 hashes, shown once; a merchant always keeps ≥ 1 active key.
- Mandate import never creates duplicates for the same `(merchant, mandateRef)`.

## Review Focus
- Merchant A must never resolve, route through, or receive webhooks for merchant B's connection id (Tasks 4–5 tests).
- A LIVE merchant with no LIVE connection gets a clear `NO_PSP_CONNECTED`, never a fallback to a shared/mock adapter (Task 4 test).
- Rotating the credentials key ring keeps old connections decryptable (Task 1 test).
- Revoking an API key takes effect on the very next request (Task 3 test).
- A CSV import with a malformed row reports that row and still imports the others; re-importing is idempotent (Task 7 test).

---

### Task 1: Credential encryption
**Files:** Create `src/security/secrets.ts`; Modify `src/config/env.ts` (`CREDENTIALS_KEYS`), `src/context.ts`; Test `test/security/secrets.test.ts`.
**Produces:** `SecretBox.fromEnv(value | undefined, nodeEnv)`, `seal(plain: object): string` (`<keyId>.<iv>.<tag>.<ciphertext>` base64url), `open<T>(sealed: string): T`; key ring `"k2:<base64 32 bytes>,k1:<…>"`, first = active; dev fallback key with warning; production without keys → error when a connection is used.
- [ ] Tests: round trip; tampered ciphertext/tag rejected; rotation (sealed with k1, opened with ring k2,k1; new seals use k2); unknown key id → clear error; wrong-length key rejected.

### Task 2: Schema
**Files:** Modify `src/db/schema.ts`; Generate migration `0009`; custom SQL to move `merchants.api_key_hash` into `api_keys`.
**Adds:** `merchants.mode` (`TEST`|`LIVE`, default `TEST`); `api_keys` (`id key_…, merchant_id, prefix, key_hash unique, label, created_at, last_used_at, revoked_at, created_by`); `psp_connections` (`id con_…, merchant_id, provider, label, environment sandbox|production, status ACTIVE|DISABLED, priority, credentials_sealed, public_hint, created_at, updated_at`).
- [ ] Migration test: existing merchant's key still authenticates after migrating.

### Task 3: API keys
**Files:** Create `src/auth/api-keys.ts`; Modify `src/api/app.ts` (auth via `api_keys`, `last_used_at` throttled), `src/api/routes/merchants.ts` (onboarding issues a first key; `mode`), new routes `POST/GET /v1/api-keys`, `POST /v1/api-keys/:id/revoke`; Test `test/api/api-keys.test.ts`.
- [ ] Tests: prefixes by mode; create/list (no hashes or secrets in list); revoke → next request 401; cannot revoke the last active key; keys are merchant-scoped.

### Task 4: Per-merchant PSP registry and routing
**Files:** Rewrite `src/psp/registry.ts`; Create `src/psp/connections.ts` (adapter factory from a connection row); Modify `src/routing/router.ts` (resolve adapters via registry; accepts an array for tests), `src/scheduler/planning.ts`, `src/scheduler/worker.ts`, `src/payments/service.ts`, `src/tracking/service.ts`, `src/disputes/*.ts`, `src/query/payments.ts`, `src/api/routes/{mandates,ops,psp-webhooks}.ts`, `src/api/dashboard/{data,analytics}.ts`, `src/context.ts`, `src/main.ts`, `src/psp/factory.ts` (shared adapters; live Cashfree env credentials refused), `src/psp/cashfree/adapter.ts` (configurable id), `src/errors.ts` (`NO_PSP_CONNECTED`).
**Produces:** `PspRegistry.get(id): Promise<PspAdapter>`, `PspRegistry.forMerchant(merchant): Promise<PspAdapter[]>`, `PspRegistry.idsFor(merchant)`, `PspRegistry.invalidate(id)`.
- [ ] Tests: TEST merchant sees shared + own sandbox connections; LIVE merchant sees only own production connections; LIVE merchant without one → `NO_PSP_CONNECTED` on payment and mandate creation; merchant B can't use A's connection id in `eligiblePsps`; disabled connection is not routed to; cache invalidated on update.

### Task 5: Connections API and per-connection webhooks
**Files:** Create `src/api/routes/connections.ts`; Modify `src/psp/cashfree/adapter.ts` (`checkCredentials()`), `src/psp/types.ts` (optional `checkCredentials`), `src/api/routes/psp-webhooks.ts`; Test `test/api/connections.test.ts`.
**Routes:** `POST /v1/psp-connections` `{ provider: 'cashfree'|'mock', label?, environment, credentials?, priority? }` (credentials verified against the PSP before saving), `GET /v1/psp-connections`, `PATCH /v1/psp-connections/:id` (`label`, `priority`, `status`, `credentials`). Responses include `webhookUrl` (`/webhooks/psp/<connection id>`) and a masked credential hint; never secrets.
- [ ] Tests: create Cashfree sandbox connection against a fake Cashfree (credentials checked; 401 → rejected, nothing saved); environment must match merchant mode; list masks secrets; rotate credentials; a webhook signed with merchant A's secret to A's connection triggers a recheck, to B's connection URL is rejected.

### Task 6: Merchant settings and webhook secret rotation
**Files:** Modify `src/api/routes/merchants.ts`, `src/api/schemas.ts`; Test `test/api/merchant-settings.test.ts`.
**Routes:** `PATCH /v1/merchants/me` (`name, webhookUrl, category, smallMerchant, methodCosts, steering`), `POST /v1/merchants/me/webhook-secret/rotate` (returns the new secret once).
- [ ] Tests: settings update and validation (webhook URL policy); rotation changes the signing secret for subsequent deliveries.

### Task 7: Bulk mandate import
**Files:** Create `src/mandates/import.ts`, `src/mandates/csv.ts`; Modify `src/api/routes/mandates.ts`, `src/psp/types.ts` (optional `mandateStatus(mandateRef)`), `src/psp/mock.ts`, `src/psp/cashfree/adapter.ts` (`GET /subscriptions/{id}`); Test `test/mandates/import.test.ts`.
**Route:** `POST /v1/mandates/import` — JSON `{ mandates: [...], verify?: boolean }` or `text/csv` (header `mandateRef,customerVpa,maxAmountPaise,eligiblePsps,noAfaLimitPaise`); ≤ 5,000 rows; returns `{ created, existing, rejected: [{ row, reason }] }`.
- [ ] Tests: JSON and CSV; malformed row reported, others imported; re-import idempotent; `verify` rejects mandates the PSP reports inactive/unknown.

### Task 8: Dashboard and demos
**Files:** `src/api/dashboard/data.ts` (meta: merchant mode, merchant's PSPs), `dashboard/app.js` (TEST MODE banner), `dashboard/styles.css`, `scripts/demo*.ts`, `README.md`, `.env.example`, `docs/runbooks/cashfree.md` (per-merchant connection setup).
- [ ] Static test still green; demos run.
