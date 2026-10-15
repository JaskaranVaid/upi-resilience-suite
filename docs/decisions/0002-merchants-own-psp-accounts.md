# 0002 — Merchants connect their own PSP accounts

Date: 2026-10-15 · Status: Accepted

## Context
Until Phase 2 the PSP credentials were process-wide environment variables, so every merchant's
payments would run through, and settle into, one account owned by us. Collecting and settling
funds on behalf of merchants is payment aggregation, which needs RBI Payment Aggregator
authorisation, escrow and net-worth requirements we neither have nor want.

## Decision
Each merchant connects its own PSP account(s) to Merchantflo (a "PSP connection": provider, mode,
encrypted credentials, webhook secret). Funds always move between the customer and the merchant's
PSP account; Merchantflo only instructs, routes, schedules and observes.

Alternative kept open: a PSP partner/platform programme (e.g. Cashfree partner onboarding) where we
onboard merchants under our partner account while settlement stays merchant-owned. That changes
onboarding, not this decision.

## Consequences
- Multi-tenant credential storage with envelope encryption (Phase 2), never logged or returned.
- Router, adapters and health are per connection; inbound PSP webhooks are routed per connection.
- Test mode and live mode are separate connections, selected by the API key used.
- Counsel to confirm the technology-service-provider position in writing (Phase 6).
