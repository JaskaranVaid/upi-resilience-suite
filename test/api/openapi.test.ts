import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { ROUTE_DOCS, UNDOCUMENTED_ROUTES } from '../../src/api/openapi.js';
import { checkoutSessionResponse, debitResponse, mandateResponse, paymentResponse } from '../../src/api/responses.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('OpenAPI', () => {
  let app: FastifyInstance;
  let key: string;
  const served = new Set<string>();
  beforeAll(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-20T14:00:00'));
    app = buildApp(buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } }));
    // Route plugins load on ready(), so this sees every API route (HEAD/OPTIONS and static wildcards left out).
    app.addHook('onRoute', (r) => {
      for (const m of [r.method].flat()) if (m !== 'HEAD' && m !== 'OPTIONS' && !r.url.includes('*')) served.add(`${m} ${r.url}`);
    });
    await app.ready();
    key = (
      await app.inject({
        method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` },
        payload: { name: 'Shop', methodCosts: { NETBANKING: { percentBps: 0, flatPaise: rs(8) } } },
      })
    ).json().apiKey;
  });

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });

  it('serves an OpenAPI 3.1 document', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Merchantflo API');
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('documents every route the server serves, except the listed internal ones', () => {
    const documented = new Set(ROUTE_DOCS.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    expect(served.size).toBeGreaterThan(40);
    const missing = [...served].filter((r) => !documented.has(r) && !UNDOCUMENTED_ROUTES.some((p) => r.split(' ')[1]!.startsWith(p)));
    expect(missing).toEqual([]);
  });

  it('documents only routes that exist', () => {
    for (const r of ROUTE_DOCS) expect(app.hasRoute({ method: r.method.toUpperCase() as 'GET', url: r.path }), `${r.method} ${r.path}`).toBe(true);
  });

  it('uses the request schemas the routes validate with', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const op = doc.paths['/v1/checkout/sessions'].post;
    const body = op.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['amountPaise']);
    expect(body.properties.amountPaise).toMatchObject({ type: 'integer', exclusiveMinimum: 0 });
    expect(op.security).toEqual([{ apiKey: [] }]);
    expect(op.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', in: 'header' })]));
    // Path params in OpenAPI form, and public checkout calls use the session token.
    const pay = doc.paths['/public/checkout/sessions/{id}/pay'].post;
    expect(pay.security).toEqual([{ checkoutToken: [] }]);
    expect(pay.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]));
  });

  it('documents responses, and real responses match them', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(doc.paths['/v1/payments'].post.responses['201'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Payment' });
    expect(doc.components.schemas.Payment.properties.customerAction.anyOf[0]).toEqual({ $ref: '#/components/schemas/CustomerAction' });
    expect(doc.paths['/v1/debits'].get.responses['200'].content['application/json'].schema.properties.data.items).toEqual({ $ref: '#/components/schemas/Debit' });
    expect(doc.paths['/v1/payments'].post.responses['400'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
    expect(doc.components.schemas.Error.properties.error.required).toEqual(['code', 'message']);

    const session = (await call('POST', '/v1/checkout/sessions', { amountPaise: rs(2500), orderId: 'ORD-1' })).json();
    checkoutSessionResponse.parse(session);
    checkoutSessionResponse.parse((await call('GET', `/v1/checkout/sessions/${session.id}`)).json());

    const payment = (await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okicici', idempotencyKey: 'p1' })).json();
    paymentResponse.parse(payment);
    paymentResponse.parse((await call('GET', `/v1/payments/${payment.id}`)).json());
    paymentResponse.parse((await call('POST', '/v1/payments', { amountPaise: rs(100), channel: 'UPI_QR', idempotencyKey: 'p2' })).json());

    const mandate = (await call('POST', '/v1/mandates', { mandateRef: 'UMN-1', customerVpa: 'ravi@okicici', maxAmountPaise: rs(1000) })).json();
    mandateResponse.parse(mandate);
    debitResponse.parse((await call('POST', `/v1/mandates/${mandate.id}/debits`, { amountPaise: rs(499), idempotencyKey: 'd1' })).json());
  });

  it('serves a reference page for the document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('/openapi.json');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
  });
});
