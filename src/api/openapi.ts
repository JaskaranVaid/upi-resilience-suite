import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUserBody } from './dashboard/plugin.js';
import { checkoutPayment, checkoutSessionResponse, debitResponse, mandateResponse, paymentResponse, pilotResponse, publicPaymentStatus, shadowDebitResponse, webhookDeliveryResponse } from './responses.js';
import { createConnectionBody, updateConnectionBody } from './routes/connections.js';
import { importMandatesBody, listDebitsQuery, movePspBody, updateMandateBody } from './routes/mandates.js';
import { changeModeBody, createApiKeyBody } from './routes/merchants.js';
import { payBody } from './routes/public-checkout.js';
import { settlementsQuery } from './routes/settlements.js';
import { erasureRequest, erasureResponse } from './routes/privacy.js';
import { listShadowDebitsQuery } from './routes/pilot.js';
import { listDeliveriesQuery } from './routes/webhook-deliveries.js';
import {
  acceptQuote, createCheckoutSession, createDebit, createMandate, createMerchant, createPayment, createVendor, quotePaid, quoteRequest, savingsQuery, splitRequest, updateMerchant,
} from './schemas.js';

type Auth = 'apiKey' | 'admin' | 'checkoutToken' | 'paymentToken' | 'none';

export interface RouteDoc {
  method: 'get' | 'post' | 'patch';
  /** Fastify form (`:id`); converted to OpenAPI's `{id}`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: Auth;
  body?: z.ZodType;
  query?: z.ZodType;
  /** Accepts an Idempotency-Key header (same as `idempotencyKey` in the body). */
  idempotent?: boolean;
  /** Success status and its body (omitted: a JSON object not specified further). */
  status?: 200 | 201 | 202 | 204;
  response?: z.ZodType;
  /** A non-JSON success body, e.g. image/svg+xml. */
  produces?: string;
}

/** Routes outside the merchant API: PSP callbacks, the dashboard's own API, these docs. */
export const UNDOCUMENTED_ROUTES = ['/webhooks/psp/', '/dashboard', '/openapi.json', '/docs', '/checkout/', '/ops'];

const list = (item: z.ZodType) => z.object({ data: z.array(item) });

export const ROUTE_DOCS: RouteDoc[] = [
  // Checkout
  {
    method: 'post', path: '/v1/checkout/sessions', tag: 'Checkout', auth: 'apiKey', body: createCheckoutSession, idempotent: true, status: 201, response: checkoutSessionResponse,
    summary: 'Create a checkout session',
    description: 'Quotes every method the merchant accepts (with any steering discount) and returns `clientToken` for checkout.js. Replaying an idempotency key returns the same session with 200.',
  },
  { method: 'get', path: '/v1/checkout/sessions/:id', tag: 'Checkout', auth: 'apiKey', response: checkoutSessionResponse, summary: 'Retrieve a checkout session' },
  { method: 'post', path: '/v1/checkout/quote', tag: 'Checkout', auth: 'apiKey', body: quoteRequest, status: 201, summary: 'Quote payment methods for an amount (Engine B)', description: 'Costs each method and, where worthwhile, offers a discount-only steering incentive. Checkout sessions do this for you.' },
  { method: 'post', path: '/v1/checkout/quotes/:id/accept', tag: 'Checkout', auth: 'apiKey', body: acceptQuote, summary: 'Record the method the customer chose' },
  { method: 'post', path: '/v1/checkout/quotes/:id/paid', tag: 'Checkout', auth: 'apiKey', body: quotePaid, summary: 'Report a quote paid outside Merchantflo', description: 'Books the steering saving when the offered method was used. Not needed for checkout sessions or /v1/payments.' },
  { method: 'post', path: '/v1/checkout/split', tag: 'Checkout', auth: 'apiKey', body: splitRequest, summary: 'Split a marketplace cart into one leg per vendor' },

  // Customer-side checkout (checkout.js)
  { method: 'get', path: '/public/checkout/sessions/:id', tag: 'Checkout (browser)', auth: 'checkoutToken', response: checkoutSessionResponse, summary: 'Session as the customer sees it' },
  { method: 'post', path: '/public/checkout/sessions/:id/pay', tag: 'Checkout (browser)', auth: 'checkoutToken', body: payBody, response: z.object({ payment: checkoutPayment.nullable() }), summary: 'Start (or return the live) payment', description: 'A session holds at most one live payment: calling this again while one is pending returns it.' },
  {
    method: 'get', path: '/public/checkout/sessions/:id/status', tag: 'Checkout (browser)', auth: 'checkoutToken',
    response: checkoutSessionResponse.pick({ id: true, status: true, returnUrl: true, payment: true }), summary: 'Poll the session and its payment',
  },
  { method: 'get', path: '/public/checkout/sessions/:id/qr.svg', tag: 'Checkout (browser)', auth: 'checkoutToken', produces: 'image/svg+xml', summary: "The current UPI QR payment's code as SVG" },
  { method: 'get', path: '/public/payments/:id/status', tag: 'Payments', auth: 'paymentToken', response: publicPaymentStatus, summary: "A payment's customer-safe status", description: 'For your own checkout page: pass the `customerStatusToken` from payment creation. Never calls a PSP.' },

  // Payments
  {
    method: 'post', path: '/v1/payments', tag: 'Payments', auth: 'apiKey', body: createPayment, idempotent: true, status: 201, response: paymentResponse,
    summary: 'Create a payment', description: 'Routed through your PSPs with health-scored failover; a timeout is status-checked before any retry, so a customer is never charged twice.',
  },
  { method: 'get', path: '/v1/payments/:id', tag: 'Payments', auth: 'apiKey', response: paymentResponse, summary: 'Retrieve a payment' },

  // AutoPay
  { method: 'post', path: '/v1/mandates', tag: 'AutoPay', auth: 'apiKey', body: createMandate, status: 201, response: mandateResponse, summary: 'Register a mandate' },
  { method: 'post', path: '/v1/mandates/import', tag: 'AutoPay', auth: 'apiKey', body: importMandatesBody, summary: 'Bulk-import existing mandates', description: 'JSON as documented, or `text/csv` with header `mandateRef,customerVpa,maxAmountPaise,eligiblePsps,noAfaLimitPaise` (and `?verify=true`). Idempotent per mandateRef.' },
  { method: 'get', path: '/v1/mandates/:id', tag: 'AutoPay', auth: 'apiKey', response: mandateResponse, summary: 'Retrieve a mandate' },
  { method: 'patch', path: '/v1/mandates/:id', tag: 'AutoPay', auth: 'apiKey', body: updateMandateBody, response: mandateResponse, summary: "Change a mandate's PSPs or limits" },
  { method: 'post', path: '/v1/mandates/:id/revoke', tag: 'AutoPay', auth: 'apiKey', response: mandateResponse, summary: 'Revoke a mandate' },
  { method: 'post', path: '/v1/mandates/move-psp', tag: 'AutoPay', auth: 'apiKey', body: movePspBody, summary: 'Point every mandate on one PSP at another' },
  {
    method: 'post', path: '/v1/mandates/:id/debits', tag: 'AutoPay', auth: 'apiKey', body: createDebit, idempotent: true, status: 201, response: z.union([debitResponse, shadowDebitResponse]),
    summary: 'Request a recurring debit',
    description:
      'Merchantflo sends the pre-debit notice and executes in a compliant off-peak slot (never in the NPCI peak windows). ' +
      'During a pilot, check `executedBy`: `MERCHANTFLO` — a Debit we execute (do not execute it yourself); `MERCHANT` — a ShadowDebit your own system executes as before, then reports with POST /v1/pilot/executions. ' +
      'A retry with the same idempotency key always returns the first answer.',
  },
  { method: 'get', path: '/v1/debits/:id', tag: 'AutoPay', auth: 'apiKey', response: debitResponse, summary: 'Retrieve a debit' },
  { method: 'get', path: '/v1/debits', tag: 'AutoPay', auth: 'apiKey', query: listDebitsQuery, response: list(debitResponse), summary: 'List debits' },

  // Pilot
  {
    method: 'get', path: '/v1/pilot', tag: 'Pilot', auth: 'apiKey', response: pilotResponse, summary: 'Your pilot rollout stage',
    description: 'Who executes your AutoPay debits during a pilot. Every debit response also says so in `executedBy`, so your integration never needs to read this.',
  },
  { method: 'get', path: '/v1/shadow-debits', tag: 'Pilot', auth: 'apiKey', query: listShadowDebitsQuery, response: z.object({ data: z.array(shadowDebitResponse), nextBefore: z.string().nullable() }), summary: 'List shadow debits', description: 'Newest first; page with `before` = the previous `nextBefore`. `reported=false` lists the ones still waiting for your outcome report.' },
  { method: 'get', path: '/v1/shadow-debits/:id', tag: 'Pilot', auth: 'apiKey', response: shadowDebitResponse, summary: 'Retrieve a shadow debit' },

  // Merchant account
  { method: 'post', path: '/v1/merchants', tag: 'Account', auth: 'admin', body: createMerchant, status: 201, summary: 'Onboard a merchant (operator)', description: 'Returns the first API key and the webhook signing secret, once.' },
  { method: 'patch', path: '/v1/admin/merchants/:id', tag: 'Account', auth: 'admin', body: changeModeBody, summary: "Change a merchant's mode (operator)" },
  {
    method: 'get', path: '/v1/admin/ops/metrics', tag: 'Operations', auth: 'admin', summary: 'Operational gauges (operator)',
    description: 'Restricted-window executions, notice failures, poller/debit/webhook backlogs, dead webhooks, failed reconciliations and open PSP circuits — what the production alarms watch.',
  },
  { method: 'get', path: '/v1/merchants/me', tag: 'Account', auth: 'apiKey', summary: 'Your merchant settings' },
  { method: 'patch', path: '/v1/merchants/me', tag: 'Account', auth: 'apiKey', body: updateMerchant, summary: 'Update your merchant settings' },
  { method: 'post', path: '/v1/merchants/me/webhook-secret/rotate', tag: 'Account', auth: 'apiKey', summary: 'Rotate the webhook signing secret', description: 'Returns the new secret once; deliveries from now on are signed with it.' },
  { method: 'post', path: '/v1/api-keys', tag: 'Account', auth: 'apiKey', body: createApiKeyBody, status: 201, summary: 'Create an API key' },
  { method: 'get', path: '/v1/api-keys', tag: 'Account', auth: 'apiKey', summary: 'List API keys' },
  { method: 'post', path: '/v1/api-keys/:id/revoke', tag: 'Account', auth: 'apiKey', summary: 'Revoke an API key' },
  { method: 'post', path: '/v1/dashboard-users', tag: 'Account', auth: 'apiKey', body: createUserBody, status: 201, summary: 'Create a dashboard user' },
  { method: 'post', path: '/v1/vendors', tag: 'Account', auth: 'apiKey', body: createVendor, status: 201, summary: 'Register a marketplace vendor' },
  { method: 'get', path: '/v1/vendors', tag: 'Account', auth: 'apiKey', summary: 'List marketplace vendors' },

  // PSP connections
  { method: 'post', path: '/v1/psp-connections', tag: 'PSP connections', auth: 'apiKey', body: createConnectionBody, status: 201, summary: 'Connect a PSP account', description: 'Credentials are checked with the PSP, sealed at rest and never returned. Test-mode merchants can add a `mock` connection.' },
  { method: 'get', path: '/v1/psp-connections', tag: 'PSP connections', auth: 'apiKey', summary: 'List PSP connections' },
  { method: 'patch', path: '/v1/psp-connections/:id', tag: 'PSP connections', auth: 'apiKey', body: updateConnectionBody, summary: 'Update a PSP connection' },
  { method: 'get', path: '/v1/psps/health', tag: 'PSP connections', auth: 'apiKey', summary: 'Health of your PSPs as the router sees it' },

  // Webhooks
  {
    method: 'get', path: '/v1/webhook-deliveries', tag: 'Webhooks', auth: 'apiKey', query: listDeliveriesQuery,
    response: z.object({ data: z.array(webhookDeliveryResponse), nextBefore: z.string().nullable() }), summary: 'List webhook deliveries', description: 'Newest first; page with `before` = the previous `nextBefore`.',
  },
  {
    method: 'post', path: '/v1/webhook-deliveries/:id/redeliver', tag: 'Webhooks', auth: 'apiKey', status: 202, response: webhookDeliveryResponse,
    summary: 'Redeliver a webhook', description: 'For a delivered or failed webhook: sends it again with the same id and payload, signed afresh with your current secret. 409 while it is still pending.',
  },

  // Privacy
  {
    method: 'post', path: '/v1/privacy/erasure', tag: 'Privacy', auth: 'apiKey', body: erasureRequest, response: erasureResponse,
    summary: 'Erase a customer’s data',
    description:
      'For a customer’s erasure request under the DPDP Act: removes their VPA and/or phone number from your mandates, payments, checkout sessions and webhook log. ' +
      'Amounts, states and references stay — they are your financial records. Matching ignores case and spacing. The audit log records the counts, never the identifiers.',
  },

  // Reporting
  { method: 'get', path: '/v1/savings', tag: 'Reporting', auth: 'apiKey', query: savingsQuery, summary: 'Value delivered (recovered payments, MDR savings)' },
  { method: 'get', path: '/v1/settlements', tag: 'Reporting', auth: 'apiKey', query: settlementsQuery, summary: 'Settlement report lines, as reconciled' },
  { method: 'get', path: '/v1/rules', tag: 'Reporting', auth: 'apiKey', summary: 'Regulatory parameters in force (peak windows, MDR)' },
  { method: 'get', path: '/health', tag: 'Operations', auth: 'none', summary: 'Liveness and database check' },
  { method: 'get', path: '/healthz', tag: 'Operations', auth: 'none', summary: 'Liveness probe (no database call)' },
  { method: 'get', path: '/readyz', tag: 'Operations', auth: 'none', summary: 'Readiness probe', description: '503 while the instance is shutting down or cannot reach its database.' },
];

const SECURITY: Record<Exclude<Auth, 'none'>, object> = {
  apiKey: { type: 'http', scheme: 'bearer', description: 'Your API key: `sk_test_…` (test mode) or `sk_live_…` (live).' },
  admin: { type: 'http', scheme: 'bearer', description: 'Operator admin token (onboarding only).' },
  checkoutToken: { type: 'apiKey', in: 'header', name: 'x-checkout-token', description: "The session's `clientToken` (also accepted as `?token=`)." },
  paymentToken: { type: 'apiKey', in: 'header', name: 'x-payment-token', description: 'The payment\'s `customerStatusToken` (also accepted as `?token=`).' },
};

const TAGS: Record<string, string> = {
  Checkout: 'Server-side: create a checkout session for an order; the customer completes it with checkout.js.',
  'Checkout (browser)': "Called by checkout.js from the customer's browser with the session's clientToken. You don't call these yourself.",
  Payments: 'One-off payments routed through your PSPs with failover and safe status checks.',
  AutoPay: 'UPI AutoPay mandates and recurring debits, executed in compliant off-peak slots.',
  Account: 'Your merchant settings, API keys, webhook secret and dashboard users.',
  'PSP connections': 'Your own PSP accounts (Cashfree, Razorpay; `mock` in test mode).',
  Webhooks: 'Signed event notifications to your webhook URL: the delivery log and redelivery.',
  Reporting: 'Value delivered, settlements and the rules in force.',
  Pilot: 'Shadow mode and canary: Merchantflo plans every debit and executes the share of mandates your pilot stage gives it; your system executes the rest and reports what happened.',
  Operations: 'Service health.',
};

const REF = '#/components/schemas/';

/** JSON Schema for one schema; registered (id'd) schemas become component refs. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  const id = z.globalRegistry.get(schema)?.id;
  if (id && io === 'output') return { $ref: REF + id };
  delete out.$schema;
  delete out.$defs; // every $def is a registered schema, already in components
  return JSON.parse(JSON.stringify(out).replaceAll('"#/$defs/', `"${REF}`));
}

function components(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, { io: 'output', unrepresentable: 'any', uri: (id) => REF + id }) as { schemas: Record<string, Record<string, unknown>> };
  for (const s of Object.values(schemas)) {
    delete s.$schema;
    delete s.$id;
  }
  return schemas;
}

/** Query parameters from a zod object schema. */
function queryParams(schema: z.ZodType): object[] {
  const s = jsonSchema(schema, 'input') as { properties?: Record<string, object>; required?: string[] };
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({ name, in: 'query', required: s.required?.includes(name) ?? false, schema: p }));
}

const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });

export function buildOpenApi(opts: { serverUrl?: string } = {}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTE_DOCS) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const pathParams = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const status = String(r.status ?? 200);
    const errors: Record<string, unknown> = {};
    const err = (description: string) => ({ description, content: json({ $ref: `${REF}Error` }) });
    if (r.body || r.query) errors['400'] = err('Invalid request (`VALIDATION`)');
    if (r.auth !== 'none') errors['401'] = err('Missing or invalid credentials');
    if (pathParams.length || r.auth === 'checkoutToken' || r.auth === 'paymentToken') errors['404'] = err('Not found (also for a wrong token)');
    if (r.method === 'post') errors['409'] = err('Conflicts with the current state (e.g. an idempotency key reused for a different request)');
    paths[path] ??= {};
    paths[path][r.method] = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      operationId: `${r.method}${path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
      security: r.auth === 'none' ? [] : [{ [r.auth]: [] }],
      parameters: [
        ...pathParams,
        ...(r.query ? queryParams(r.query) : []),
        ...(r.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 }, description: 'Same as `idempotencyKey` in the body.' }] : []),
      ],
      ...(r.body ? { requestBody: { required: true, content: json(jsonSchema(r.body, 'input')) } } : {}),
      responses: {
        [status]: {
          description: 'OK',
          ...(r.produces ? { content: { [r.produces]: { schema: { type: 'string' } } } } : { content: json(r.response ? jsonSchema(r.response, 'output') : { type: 'object' }) }),
        },
        ...errors,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Merchantflo API',
      version: 'v1',
      description:
        'UPI payment resilience: peak-aware AutoPay scheduling, MDR-aware checkout steering and health-scored PSP routing on your own PSP accounts. Amounts are integer paise. Test mode (`sk_test_` keys) never moves real money.',
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    tags: [...new Set(ROUTE_DOCS.map((r) => r.tag))].map((name) => ({ name, ...(TAGS[name] ? { description: TAGS[name] } : {}) })),
    paths,
    components: { schemas: components(), securitySchemes: SECURITY },
  };
}

const REDOC = 'https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js';

export const docsRoutes = () => async (app: FastifyInstance) => {
  let doc: Record<string, unknown> | undefined;
  app.get('/openapi.json', async (_req, reply) => reply.header('access-control-allow-origin', '*').send((doc ??= buildOpenApi())));
  app.get('/docs', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.redoc.ly; worker-src blob:; frame-ancestors 'none'; base-uri 'none'")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Merchantflo API</title></head>` +
          `<body><redoc spec-url="/openapi.json"></redoc><script src="${REDOC}" crossorigin="anonymous"></script></body></html>`,
      ),
  );
};
