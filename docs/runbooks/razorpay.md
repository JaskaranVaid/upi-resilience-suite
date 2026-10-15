# Runbook — Razorpay

Razorpay is a **one-off payments** provider in Merchantflo: UPI collect and intent (server-to-server),
cards and netbanking through Razorpay Checkout, status, reversals, webhooks and settlement
reconciliation. It does **not** execute UPI AutoPay for Merchantflo (Razorpay runs its own recurring
schedule, which would take timing away from Engine A), so a Razorpay connection can't be named on a
mandate.

## 1. Connect a merchant's Razorpay account

```http
POST /v1/psp-connections
{ "provider": "razorpay",
  "credentials": { "keyId": "rzp_live_…", "keySecret": "…", "webhookSecret": "…" } }
```

- Test-mode merchants use `rzp_test_` keys; live merchants `rzp_live_` keys (enforced).
- The keys are checked with an order listing before saving, then sealed; never returned.
- `webhookSecret` is the secret you set on the webhook in the Razorpay dashboard (not the key secret).

## 2. Razorpay dashboard settings

| Setting | Value |
|---|---|
| **Payment capture** | *Automatic* (Settings → Payment Capture). An authorized payment that is never captured is reversed by Razorpay; Merchantflo reports it as a reversal. |
| **S2S UPI** | Ask Razorpay to enable server-to-server UPI (collect/intent) for the account; without it, use cards/netbanking via Checkout. |
| **Webhooks** | URL = the connection's `webhookUrl`; events `order.paid`, `payment.failed`, `payment.captured`, `refund.processed`; secret = `webhookSecret`. |

## 3. How it behaves

- Our reference is the order **receipt**; an existing order is always looked up by receipt before one is
  created, so a retried attempt never creates a second order.
- UPI intent returns the deeplink Razorpay gives (`next[].action = intent`) — passed through unmodified.
- `customerPhone` is required; email is sent as Razorpay's documented placeholder `void@razorpay.com`.
- Pass the customer's `client: { ip, userAgent }` on `POST /v1/payments` when you have it (S2S requires it).
- Status: `captured` → success; `authorized` → pending, customer debited; `failed` → customer decline or
  technical failure by `error_source`/`error_reason`; uncaptured + refunded → reversal.
- Settlements: `GET /v1/settlements/recon/combined` per IST day, matched by Razorpay payment id.

## 4. Verify with test keys

```
RAZORPAY_KEY_ID=rzp_test_…  RAZORPAY_KEY_SECRET=…  (in .env)
npm run smoke:razorpay                      # keys
SMOKE_PHONE=9876543210 npm run smoke:razorpay   # + ₹1 intent and card checkout
SMOKE_RECON_DAY=2026-10-14 npm run smoke:razorpay
```
The script refuses live keys and never prints secrets.

## 5. Go-live checklist

1. [ ] S2S UPI enabled (or the merchant accepts Checkout-only UPI).
2. [ ] Automatic capture on.
3. [ ] Webhook configured with the connection's URL and secret; a test event returns `200 {"received":true}`.
4. [ ] Smoke test with test keys passes; record any response shape that differs from this runbook.
5. [ ] Live connection created with `rzp_live_` keys on the live merchant.
