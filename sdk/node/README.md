# @merchantflo/node

Typed Node.js client and webhook verifier for the Merchantflo API. No runtime dependencies; Node 18+.

```bash
npm install ./sdk/node   # from this repository (not published to npm yet)
```

```ts
import { Merchantflo, MerchantfloError } from '@merchantflo/node';

const mf = new Merchantflo({ apiKey: process.env.MERCHANTFLO_API_KEY!, baseUrl: process.env.MERCHANTFLO_URL! });

// Checkout: create a session on your server, hand id + clientToken to checkout.js in the browser.
const session = await mf.checkout.sessions.create({ amountPaise: 249900, orderId: 'ORD-1001' }, { idempotencyKey: 'ORD-1001' });

// One-off payment routed through your PSPs.
const payment = await mf.payments.create({ amountPaise: 49900, payerVpa: 'asha@okicici' }, { idempotencyKey: 'ORD-1002' });

// AutoPay: register a mandate, then request debits whenever your billing runs.
const mandate = await mf.mandates.create({ mandateRef: 'UMN-123', customerVpa: 'asha@okicici', maxAmountPaise: 99900 });
const debit = await mf.debits.create(mandate.id, { amountPaise: 49900 }, { idempotencyKey: 'INV-2026-11' });

try {
  await mf.payments.retrieve('pay_unknown');
} catch (e) {
  if (e instanceof MerchantfloError) console.log(e.status, e.code, e.message); // 404 NOT_FOUND …
}
```

Amounts are integer paise. Anything not wrapped yet is reachable with `mf.request(method, path, body)`.

**Retries.** Reads, and writes that carry an `idempotencyKey`, are retried on network errors, 429
and 5xx (`maxRetries`, default 2, with exponential backoff). Other writes are never retried: pass an
idempotency key to make a create safe to repeat.

## Webhooks

Verify every webhook against the **raw** body before acting on it:

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from '@merchantflo/node';

app.post('/webhooks/merchantflo', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook({ payload: req.body, headers: req.headers, secret: process.env.MERCHANTFLO_WEBHOOK_SECRET! });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.status(400).send(e.message);
    throw e;
  }
  // event.id is stable across retries and redeliveries: skip ids you have already handled.
  res.sendStatus(200);
});
```

`verifyWebhook` checks `x-resilience-signature` (`sha256=` HMAC-SHA256 of `"<timestamp>.<body>"`)
with a timing-safe comparison and rejects timestamps more than 5 minutes off (`toleranceSeconds`).

See the [integration guide](../../docs/integration-guide.md) for the events and their payloads.
