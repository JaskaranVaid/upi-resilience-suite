# Phase 4 — Checkout and Integration Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer who didn't build Merchantflo integrates checkout and AutoPay in test mode in under a day, from the docs alone.

**Architecture:** Checkout sessions wrap Engine B's quote and the payment flow: the merchant's server creates a session; the customer's browser (the `checkout.js` widget) reads it and pays through token-protected public endpoints; the session owns at most one live payment. Steering savings are booked automatically when the steered payment succeeds. OpenAPI is generated from the zod schemas the routes already validate with. A small typed Node SDK and webhook verifier live in `sdk/node`. Test-mode mock PSPs act out scenarios selected by magic amounts. Webhook deliveries are listable and replayable.

**Tech Stack:** existing + `qrcode` (server-side SVG QR rendering). Zod 4 `z.toJSONSchema` for OpenAPI.

**Spec:** `docs/roadmap.md` Phase 4.

## Global Constraints
- The customer is never charged more than the cart amount; a steered method's discount is applied to the payment amount itself.
- A session has at most one live (pending) payment; paying again while one is pending returns it.
- Public checkout endpoints reveal only customer-safe fields and require the session token; no cookies; `Cache-Control: no-store`.
- Magic-amount scenarios run only on mock PSPs (never reach a real PSP).
- SDK has zero runtime dependencies and verifies webhooks with a timing-safe comparison and a timestamp tolerance.

## Review Focus
- Two concurrent "pay" calls on one session must not create two payments (Task 1 test).
- A steered NETBANKING payment charges the discounted amount and books the saving once on success (Task 1 test).
- An expired session can't be paid; a paid session can't be paid again (Task 1 test).
- The checkout token for session A can't read or pay session B (Task 1 test).
- A redelivered webhook keeps its original id and is signed fresh (Task 6 test).

---

### Task 1: Checkout sessions
Files: schema + migration (`checkout_sessions`); `src/checkout/sessions.ts`; `src/api/routes/checkout.ts` (`POST /v1/checkout/sessions`, `GET /v1/checkout/sessions/:id`); `src/api/routes/public-checkout.ts` (`GET /public/checkout/sessions/:id`, `POST …/pay`, `GET …/status`, `GET …/qr.svg`); `src/payments/outcome.ts` (book steering on success); tests `test/api/checkout-sessions.test.ts`.

### Task 2: checkout.js widget
Files: `checkout/v1/checkout.js`, `checkout/v1/checkout.css`, `checkout/demo.html`; static serving at `/checkout/`; test `test/api/checkout-static.test.ts`.

### Task 3: Test-mode scenarios
Files: `src/psp/mock.ts` (`scenarios` option; amounts ending in paise 51–57), `src/psp/connections.ts` (on for mock connections), `src/psp/factory.ts` (on for shared mocks outside production); tests `test/psp/scenarios.test.ts`; table in the integration guide.

### Task 4: OpenAPI
Files: `src/api/openapi.ts` (route registry → OpenAPI 3.1 with zod JSON schemas), `GET /openapi.json`, `GET /docs` (Redoc page), test `test/api/openapi.test.ts`.

### Task 5: Node SDK
Files: `sdk/node/{package.json,tsconfig.json,README.md,src/index.ts,src/webhooks.ts}`; tests `test/sdk/sdk.test.ts` (against the app through an inject-backed fetch).

### Task 6: Webhook deliveries
Files: `src/webhooks/deliveries.ts`; `GET /v1/webhook-deliveries`, `POST /v1/webhook-deliveries/:id/redeliver`; dashboard Developers page (`dashboard/views/developers.js`: deliveries, API keys, PSP connections — admins); tests.

### Task 7: Integration guide
Files: `docs/integration-guide.md` (quickstart: onboard → connect PSP → checkout session + widget → AutoPay intake → webhooks → go live), README link, roadmap.
