# 0001 — The REST `/v1` API is the merchant contract

Date: 2026-10-15 · Status: Accepted

## Context
The founding blueprint ("Merchantflo Divisions", §5) sketched one inbound payload for every
operation (`merchantflo_merchant_id`, `transaction_details.transaction_type`, `routing_preferences`)
and one outbound webhook shape (`status: queued_for_off_peak`, `revenue_optimization`). The shipped
system exposes resource-oriented REST endpoints (`/v1/mandates/:id/debits`, `/v1/checkout/quote`,
`/v1/payments`, …) with integer paise, idempotency keys and typed webhook events.

## Decision
The REST API is the contract. The blueprint payloads are retired, not implemented as a second API.

Mapping for anyone reading the blueprint:

| Blueprint | REST |
|---|---|
| `merchantflo_merchant_id` | Implied by the API key |
| `transaction_type: "recurring"` + `mandate_id` | `POST /v1/mandates/:id/debits` |
| `transaction_type: "one-time"` | `POST /v1/checkout/quote` then `POST /v1/payments` (Phase 4: checkout sessions) |
| `amount: 5000.00` (rupees, float) | `amountPaise: 500000` (integer paise) |
| `routing_preferences.bypass_mdr_steering` | Merchant steering config (`steering.enabled`) |
| `routing_preferences.enable_smart_retry` | Always on; safety rules are not optional |
| Webhook `status: queued_for_off_peak` | `debit.scheduled` with `scheduledAt`, `noticeDate` |
| Webhook `revenue_optimization.mdr_fee_avoided` | `/v1/savings`, dashboard Value section, statement CSV |

## Consequences
- One published contract (OpenAPI in Phase 4), versioned under `/v1`; breaking changes need `/v2`.
- The blueprint document is historical context, not a spec.
- Smart retry and peak-window compliance cannot be switched off per request: they are safety rules.
