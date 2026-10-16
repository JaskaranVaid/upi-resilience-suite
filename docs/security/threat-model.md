# Threat model

Merchantflo sits between merchants and their payment providers (PSPs). It never holds funds: money
moves between the customer's bank and the merchant's own PSP account. What it holds is the
**power to move money** (it tells PSPs to execute AutoPay debits and start collects), **customer
identifiers** (VPAs, phone numbers) and **merchants' PSP credentials**. This document lists, per
trust boundary, what can go wrong (STRIDE), what stops it today, and what risk remains.

Reviewed: 2026-10-16 (Phase 6). Review again before the pen test, at each new PSP, and after any
change to authentication.

## Assets

| Asset | Why it matters | Where |
|---|---|---|
| Ability to execute debits and start payments | Wrong or duplicate debits harm customers and merchants directly | Worker, `/v1/debits`, `/v1/payments` |
| Merchants' PSP credentials | Full control of a merchant's PSP account | `psp_connections.credentials` (sealed, AES-256-GCM) |
| Customer identifiers (VPA, phone, payment links) | Personal data under the DPDP Act | `mandates`, `payments`, `checkout_sessions`, `webhook_outbox` (sealed at rest) |
| Merchant API keys, dashboard and operator sessions | Act as a merchant or as Merchantflo staff | Stored as SHA-256 hashes; sessions as hashed opaque tokens |
| Merchant webhook signing secrets | Forge events to a merchant | `merchants.webhook_secret` (plaintext, see residual risks) |
| `ADMIN_TOKEN`, `CUSTOMER_TOKEN_SECRET`, `CREDENTIALS_KEYS` | Platform-wide control | AWS Secrets Manager (KMS), injected into ECS tasks |
| Audit trail | Evidence for disputes, regulators and incidents | `payment_events`, `operator_audit` |

## Trust boundaries

```
 customer browser ──(checkout.js, /public/*)──┐
 merchant server ───(/v1/*, API key)──────────┤
 merchant staff ────(/dashboard, cookie)──────┼──► ALB + WAF ──► api (ECS) ──► RDS PostgreSQL
 Merchantflo staff ─(/ops, cookie + TOTP)─────┤                    │  ▲
 PSPs ──────────────(/webhooks/psp/*)─────────┘                    ▼  │
                                                   worker (ECS) ──► PSP APIs (outbound)
                                                                └─► merchant webhook URLs (outbound)
 founders ──(AWS console/CLI, GitHub)──► Terraform, deploy pipeline, Secrets Manager
```

## 1. Merchant server → API (`/v1`)

| Threat | Mitigation | Residual |
|---|---|---|
| **S** Stolen or guessed API key | 192-bit random keys, `sk_test_`/`sk_live_` prefixes, stored as hashes; multiple keys with revoke and rotate; per-IP cap on failed authentication before any lookup | A leaked key works until revoked: no IP allowlist per key yet |
| **T** Replayed or altered requests | TLS only; idempotency keys on every money-moving call (same key + different body → 409) | — |
| **R** Merchant denies having asked for a debit | Every intake, notice, execution and status change is an event with actor and time | — |
| **I** One merchant reading another's data | Every query is scoped by the authenticated merchant id; tests cover isolation (Phase 2) | A missed `where merchant_id` in new code; reviewed in each PR and by the pen test |
| **D** Request floods | Per-key rate limit (1,200/min), WAF managed rules, ALB | In-process counters: limits are per api task, not global |
| **E** Test key moving real money | Test-mode merchants can only use sandbox/mock PSPs; live connections refuse sandbox credentials and the reverse | — |

## 2. Customer browser → checkout (`/public/*`, `checkout.js`)

| Threat | Mitigation | Residual |
|---|---|---|
| **S** Paying or reading someone else's checkout | Session id plus an HMAC client token (`CUSTOMER_TOKEN_SECRET`) | Whoever holds the link can pay it (by design) |
| **T** Tampering with amount or method | Amount and quote are server-side; the browser only picks among quoted methods | — |
| **T** Marking a session paid without paying | Payment state comes only from PSP status checks; webhook bodies never decide state | — |
| **I** Return-URL abuse (open redirect, `javascript:`) | `returnUrl` must be http(s), set by the merchant server-side | — |
| **D** Pay-button hammering | Pay lock per session; per-IP limit on `/public` (300/min) | — |

## 3. Merchant staff → dashboard (`/dashboard`)

| Threat | Mitigation | Residual |
|---|---|---|
| **S** Password guessing, credential stuffing | scrypt hashes, 12+ characters, lockout after 5 failures, login rate limit, **optional TOTP** (Phase 6) | Two-factor is optional for merchant users; recommended for admins |
| **T** CSRF | `SameSite=Strict` httpOnly cookie plus a required `X-Dashboard-Request` header on state changes | — |
| **I** XSS exfiltrating data | Strict CSP (`default-src 'self'`, no inline script/style), all output escaped by one template helper | — |
| **E** Support user acting as admin | Roles enforced server-side (ADMIN/SUPPORT/VIEWER) | — |

## 4. Merchantflo staff → ops console (`/ops`)

The ops console can stop every merchant's payments and erase data, so it is held to a higher bar.

| Threat | Mitigation | Residual |
|---|---|---|
| **S** Stolen operator password | TOTP required at every sign-in, single-use codes, lockout, 15-minute idle and 8-hour absolute sessions | Console is reachable from the internet; restricting `/ops/*` to office/VPN IPs in the WAF is founder action #24 |
| **R** Operator denies pausing or erasing | `operator_audit` records who, when, what and why for every sign-in, pause, lift and erasure | Audit rows are in the same database an attacker with DB access could edit |
| **E** Viewer pausing payments | OWNER/OPERATOR/VIEWER roles enforced server-side | — |
| **I** Enrolment secrets in logs | Operator CLI prints a one-time password and authenticator URI; in AWS they land in the migrate log stream | The runbook deletes that log stream right after reading; anyone with CloudWatch read access in that window could copy them ([operators runbook](../runbooks/operators.md)) |

## 5. PSPs → inbound webhooks (`/webhooks/psp/*`)

| Threat | Mitigation | Residual |
|---|---|---|
| **S** Forged PSP webhook | Signature verified on the raw body with the connection's secret, replay window; and the payload never decides state — it only triggers a status check against the PSP's API | — |
| **D** Webhook floods | Lease-guarded re-checks (one in flight per payment), WAF | — |

## 6. Worker → PSP APIs and merchant webhooks (outbound)

| Threat | Mitigation | Residual |
|---|---|---|
| **T** Double debit after a timeout | Status check before any retry or failover; deterministic transaction references; idempotent execution | Depends on each PSP honouring its own idempotency; covered by contract tests |
| **T** Execution in an NPCI peak window | Window re-checked immediately before execution; alarm `restricted-window-execution` | — |
| **I** SSRF through merchant webhook URLs | https + public hosts only in production, DNS resolved and pinned, private/IPv6-embedded ranges refused, no redirects | — |
| **I** Forged events sent to merchants | HMAC-SHA256 signature with timestamp per delivery | Merchants must verify; the SDK does it for them |
| **D** A broken PSP stalls everything | Circuit breakers per connection, failover, kill switch per PSP (Phase 6) | — |

## 7. Data at rest (RDS, backups, logs)

| Threat | Mitigation | Residual |
|---|---|---|
| **I** Database or snapshot leak | RDS storage encryption (KMS); PSP credentials and customer identifiers additionally sealed in the application with keys only the app holds; TLS to RDS (`verify-full`) | `webhook_secret`, merchant names, amounts and references are not application-encrypted |
| **I** Keeping personal data longer than needed | Retention job: identifiers on finished payments/sessions redacted after 180 days, webhook logs deleted after 30 ([retention policy](../legal/retention-policy.md)); erasure on request | RDS backups (35 days in production) and CloudWatch logs (365 days) keep older copies until they age out |
| **I** Personal data in logs | Logs carry ids, not VPAs or phone numbers | Not enforced by a test; checked in review |

## 8. Founders → AWS, GitHub, deploy pipeline

| Threat | Mitigation | Residual |
|---|---|---|
| **S/E** Compromised AWS or GitHub account | MFA on all human accounts (founder action), deploy via OIDC roles (no long-lived keys), production deploys need an approver | Three people with broad access; no separation of duties yet |
| **T** Malicious dependency | `npm audit` gate (high/critical), Dependabot, lock file, CodeQL, Trivy on the image | A compromised package between audits |
| **I** Secrets in git | gitleaks over full history in CI; secrets only in Secrets Manager | — |

## Emergency controls

- **Kill switch** (ops console → Kill switch): pause new money movement globally, per merchant or
  per PSP within seconds. Nothing is cancelled; status checks, reconciliation and webhooks carry
  on. [Runbook](../runbooks/kill-switch.md).
- **Revoke** an API key or disable a dashboard user or operator: takes effect on the next request.
- **Rotate** `CREDENTIALS_KEYS` (new key first in the ring, then `npm run privacy:backfill` and
  PSP credential re-sealing), `ADMIN_TOKEN`, `CUSTOMER_TOKEN_SECRET`: [incident response](../runbooks/incident-response.md).

## Open items before go-live

1. External penetration test, scope in [pentest-scope.md](pentest-scope.md); fix all high findings.
2. Restrict `/ops/*` to known IPs at the WAF (founder action #24).
3. Seal `merchants.webhook_secret` like PSP credentials.
4. Ship audit rows to a write-once store (S3 Object Lock) so a database compromise cannot rewrite them.
5. Decide whether two-factor sign-in becomes mandatory for merchant admins (a merchant setting).
