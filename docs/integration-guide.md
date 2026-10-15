# Merchantflo integration guide

From zero to a working test-mode integration: a checkout on your site, recurring AutoPay debits, and
signed webhooks. Everything here runs in **test mode**, where no real money moves. The last section
covers going live.

- API reference: `GET /docs` on your Merchantflo host (OpenAPI document at `/openapi.json`)
- Node SDK: [`sdk/node`](../sdk/node/README.md) (typed client and webhook verifier)
- Drop-in checkout: `/checkout/v1/checkout.js` (demo at `/checkout/demo.html`)

Money is always **integer paise** (₹2,499.00 = `249900`). Errors look like
`{ "error": { "code": "VALIDATION", "message": "…" } }`.

## 1. Run Merchantflo locally

```bash
npm install
ADMIN_TOKEN=local-admin-token-change-me npm run dev     # API, worker and poller on http://localhost:3000
```

On Windows PowerShell: `$env:ADMIN_TOKEN = "local-admin-token-change-me"; npm run dev`.

Local data lives in `.data/pg`. Two simulated PSPs (`pspA`, `pspB`) are configured by default, so a
test merchant can take payments straight away. To reset everything, stop the server and delete `.data/pg`.

## 2. Create a test merchant

Onboarding uses the operator's admin token. The response contains your **API key** and **webhook
signing secret**, and this is the only time you will see them. Store both.

```bash
curl -s http://localhost:3000/v1/merchants \
  -H "authorization: Bearer local-admin-token-change-me" -H "content-type: application/json" \
  -d '{"name": "My Shop", "webhookUrl": "http://localhost:4000/webhooks/merchantflo",
       "methodCosts": {"NETBANKING": {"percentBps": 0, "flatPaise": 800}, "CARD": {"percentBps": 180, "flatPaise": 0}}}'
```

```json
{ "merchant": { "id": "mer_…", "mode": "TEST", … }, "apiKey": "sk_test_…", "webhookSecret": "whsec_…" }
```

- `sk_test_…` keys only ever reach sandbox or simulated PSPs.
- `methodCosts` is what each non-UPI method costs you. Checkout offers UPI plus the methods
  listed here, and Merchantflo uses the costs to steer customers to a cheaper method with a discount
  when that saves you money (see §3).
- In development, webhook URLs may be `http://localhost`. In production they must be public `https`.

From here on, `$KEY` is your `sk_test_…` key:

```bash
export KEY=sk_test_…            # PowerShell: $env:KEY = "sk_test_…"
```

### Optional: connect your own PSP sandbox

The shared simulated PSPs are enough for this guide. To test against your own Cashfree or Razorpay
sandbox, connect it. Merchantflo checks the keys with the PSP, stores them encrypted and never returns them:

```bash
curl -s http://localhost:3000/v1/psp-connections -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"provider": "cashfree", "credentials": {"clientId": "…", "clientSecret": "…"}}'
```

The response's `webhookUrl` is the address to enter in the PSP's dashboard for payment webhooks. A
test merchant can also add `{"provider": "mock"}`, a private simulated PSP. Provider notes are in
the [Cashfree](runbooks/cashfree.md) and [Razorpay](runbooks/razorpay.md) runbooks.

## 3. Take a payment with checkout.js

**On your server**, create a checkout session for the order:

```bash
curl -s http://localhost:3000/v1/checkout/sessions -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -H "idempotency-key: ORD-1001" \
  -d '{"amountPaise": 500000, "orderId": "ORD-1001", "returnUrl": "https://shop.example/orders/ORD-1001"}'
```

```json
{
  "id": "cks_…", "status": "OPEN", "amountPaise": 500000, "orderId": "ORD-1001",
  "methods": [
    { "method": "UPI", "payablePaise": 500000, "discountPaise": 0, "recommended": false, "upiFlows": ["INTENT", "QR", "COLLECT"] },
    { "method": "NETBANKING", "payablePaise": 499700, "discountPaise": 300, "recommended": true },
    { "method": "CARD", "payablePaise": 500000, "discountPaise": 0, "recommended": false }
  ],
  "payment": null,
  "clientToken": "…"
}
```

Here UPI would cost you 0.4% MDR (₹20), while netbanking costs ₹8. Merchantflo shares part of
the ₹12 saving with the customer as a ₹3 discount. The `steering` settings control the share and
the minimum saving worth offering (₹5 by default). A discount appears only while the UPI MDR regime
is in force, which is configured with `MDR_EFFECTIVE_FROM`; run the server with
`MDR_EFFECTIVE_FROM=2026-10-01` to see it locally. The customer never pays more than the cart
amount: a discount always comes off another method, never an extra charge on UPI.

**On your page**, mount the widget with the session's `id` and `clientToken`. Never put your API key in the page.

```html
<div id="pay"></div>
<script src="http://localhost:3000/checkout/v1/checkout.js"></script>
<script>
  Merchantflo.mount(document.getElementById('pay'), {
    sessionId: 'cks_…',
    token: '…',                       // clientToken: reads and pays this one session only
    onComplete: (r) => console.log(r) // { status: 'success' | 'failed', paymentId }
  });
</script>
```

The widget:

- lists the methods with their payable amounts and any saving;
- offers a UPI app on phones, a QR code on desktops, or a UPI ID;
- opens the PSP's own checkout for cards, so card details never touch Merchantflo or your page;
- polls until the payment completes, then calls `onComplete` and goes to `returnUrl`.

It renders in a shadow root and loads `checkout.css` from the same folder as `checkout.js`. If your
page has a strict CSP, allow your Merchantflo origin in `script-src`, `style-src`, `img-src` and
`connect-src`. For card payments, also allow your PSP's checkout script and frames
(`https://sdk.cashfree.com` or `https://checkout.razorpay.com`). To try the widget without writing a page, open
`http://localhost:3000/checkout/demo.html?session=cks_…&token=…`.

**Don't trust the browser for fulfilment.** Ship the order when you receive the
`payment.succeeded` webhook (§5), or when `GET /v1/checkout/sessions/:id` returns `status: "PAID"`.

Without the widget, `POST /v1/payments` creates a payment directly. Its `customerAction` tells you
what to show: a `upi://` link, QR data, a bank redirect or the PSP checkout. See the API reference.

## 4. Recurring payments with UPI AutoPay

Register a mandate the customer has already approved at your PSP. Then hand Merchantflo each debit
when your billing runs, whatever the time of day:

```bash
curl -s http://localhost:3000/v1/mandates -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"mandateRef": "UMN-123", "customerVpa": "asha@okicici", "maxAmountPaise": 99900}'

curl -s http://localhost:3000/v1/mandates/mdt_…/debits -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -H "idempotency-key: INV-2026-11-asha" -d '{"amountPaise": 49900, "orderId": "INV-2026-11"}'
```

```json
{ "id": "dbt_…", "state": "SCHEDULED", "requestedInPeak": true, "noticeDate": "2026-10-16",
  "scheduledAt": "2026-10-16T08:47:13.000Z", "noticePending": false, "attempts": 0, "maxAttempts": 3 }
```

Merchantflo sends the pre-debit notice. It then executes in an off-peak slot on the notified date,
never inside NPCI's restricted windows (10:00–13:00 and 17:00–21:30 IST). Technical declines are
retried in later slots, and every outcome arrives as a webhook (`debit.succeeded` /
`debit.failed`). Debits above ₹15,000 are refused at intake with `AFA_REQUIRED`, since they need
the customer to authenticate. Mandates that already exist at your PSP can be bulk-imported with
`POST /v1/mandates/import`.

## 5. Webhooks

Merchantflo POSTs JSON to your `webhookUrl`:

```json
{ "id": "whk_…", "event": "payment.succeeded", "createdAt": "2026-10-20T08:30:00.000Z", "data": { … } }
```

| Event | When | `data` |
|---|---|---|
| `payment.succeeded`, `payment.failed` | Final outcome of a payment | the Payment object |
| `payment.reversal_initiated`, `payment.reversed` | The customer was debited for a failed payment, and their bank is reversing / has reversed it | payment facts |
| `payment.captured_after_failure` | The PSP captured a payment after it was reported failed. Fulfil the order or refund. | payment facts |
| `case.needs_action`, `case.resolved` | A payment issue needs you / was resolved | payment facts + `case` |
| `debit.scheduled`, `debit.notice_sent`, `debit.rescheduled` | AutoPay debit accepted, notice sent, moved to another slot (`reason`) | the Debit object |
| `debit.succeeded`, `debit.failed` | Final AutoPay outcome | the Debit object |

"Payment facts" are `paymentType` (`COLLECT` or `AUTOPAY`), `paymentId`, `orderId`, `amountPaise`,
`upiRrn`, `customerDebit`, `capture` and `reversal`, never internal PSP codes.

**Verify every webhook** before acting on it. Each request carries `x-resilience-timestamp` and
`x-resilience-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with your webhook secret>`.
With the SDK:

```ts
import { verifyWebhook } from '@merchantflo/node';
const event = verifyWebhook({ payload: rawBody, headers: req.headers, secret: process.env.MERCHANTFLO_WEBHOOK_SECRET! });
```

Without the SDK, recompute the HMAC over the raw bytes, compare in constant time, and reject
timestamps more than 5 minutes old.

**Delivery.** Respond with any 2xx within 10 seconds. Failures are retried with exponential backoff
(8 attempts over about 45 minutes), after which the webhook is marked failed and can be redelivered.
A webhook can arrive more than once, so de-duplicate on `id`.
Redirects are not followed.

**Delivery log.** `GET /v1/webhook-deliveries?status=failed` lists deliveries with their attempts
and last error. `POST /v1/webhook-deliveries/:id/redeliver` sends a delivered or failed webhook again,
with the same `id`, signed with your current secret. Admins see the same log, with a Redeliver button,
under **Developers** in the dashboard. To rotate the secret, call
`POST /v1/merchants/me/webhook-secret/rotate`; deliveries are signed with the new secret from then on.

## 6. Test scenarios

In test mode, the simulated PSPs act out a scenario chosen by the **paise of the amount charged**.
The rupees can be anything:

| Amount ends in | Outcome | What happens |
|---|---|---|
| `.51` | Failed, not charged | The customer's bank declines (insufficient funds). Never retried. |
| `.52` | Succeeded via failover | The bank is down at the first PSP tried. Merchantflo fails over to the next PSP and the payment succeeds. With only one PSP it fails, and the customer is not charged. |
| `.53` | Succeeded after a status check | The PSP times out, but the payment went through. The status check finds it instead of charging again. |
| `.54` | Verifying, then failed (not charged) | The PSP times out and the payment never reached the bank. Status checks find nothing, so the payment fails. |
| `.55` | Debited, then reversed | Reported failed, but the customer was debited. Watch `payment.reversal_initiated` then `payment.reversed`. |
| `.56` | Debited, not captured | Reported failed, but the customer was debited and no reversal appears. It stays under verification, then needs action in the Dispute Desk. |
| `.57` | Captured after failure | Reported failed, then captured by the PSP. You receive `payment.captured_after_failure`. |

Any other amount succeeds. Scenarios also apply to AutoPay debits. Two things to watch for:

- The scenario follows the amount actually charged. A steered method's discount changes the
  amount, so pick a method without a discount (UPI) when you test a scenario through checkout.
- Scenarios exist only on simulated PSPs (shared mocks outside production and `mock` connections).
  They never reach a real PSP.

Payments that need the poller (.54–.57) move on within a minute or two. Follow them in
`GET /v1/payments/:id` (`merchantStatus`) or in the dashboard.

## 7. Integration checklist

- [ ] API key and webhook secret kept server-side, in your secret store
- [ ] An idempotency key (your order or invoice id) on every create, so retries can't duplicate
- [ ] Webhook signatures verified on the raw body, duplicate `id`s ignored, a 2xx returned quickly
- [ ] Orders fulfilled from `payment.succeeded` / `debit.succeeded`, not from the browser
- [ ] `payment.captured_after_failure` and `case.needs_action` reach a person
- [ ] Every scenario in §6 tried once

## 8. Going live

1. The Merchantflo operator onboards a **live** merchant (`"mode": "LIVE"`). You get an `sk_live_…`
   key and a new webhook secret. Test and live are separate merchants with separate data.
2. Connect your **production** PSP account (`POST /v1/psp-connections`). Live merchants route only
   through their own production connections, never shared or simulated ones. For AutoPay through
   Cashfree, ask Cashfree to enable it on your account first.
3. Set an `https` webhook URL on a public host (`PATCH /v1/merchants/me`), and enter each
   connection's `webhookUrl` in your PSP's dashboard.
4. Point checkout.js and your server at the production Merchantflo host, using the live key.
5. Watch the first payments in the dashboard (**Payments**, **Dispute Desk**, **Developers →
   Webhook deliveries**).
