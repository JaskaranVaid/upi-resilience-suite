import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('HTTP API (end to end)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let pspA: MockPsp;
  let pspB: MockPsp;
  let apiKey: string;

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, token = apiKey, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...headers } });

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T10:30:00'));
    pspA = new MockPsp('pspA');
    pspB = new MockPsp('pspB');
    ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    const res = await call('POST', '/v1/merchants', {
      name: 'StreamCo',
      webhookUrl: 'https://streamco.example/hooks',
      methodCosts: { NETBANKING: { percentBps: 0, flatPaise: rs(8) } },
    }, ADMIN);
    expect(res.statusCode).toBe(201);
    apiKey = res.json().apiKey;
  });

  it('rejects requests without a valid API key or admin token', async () => {
    expect((await call('GET', '/v1/merchants/me', undefined, 'nope')).statusCode).toBe(401);
    expect((await call('POST', '/v1/merchants', { name: 'x' }, 'nope')).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/v1/savings' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 with field details on invalid input', async () => {
    const res = await call('POST', '/v1/checkout/quote', { amountPaise: 12.5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('amountPaise');
  });

  it('Engine A: a peak-hour billing call is deferred, notified, executed off-peak and counted as saved', async () => {
    const mandate = (await call('POST', '/v1/mandates', { mandateRef: 'UMN-9', customerVpa: 'asha@okhdfc', maxAmountPaise: rs(1000) })).json();
    expect(mandate.eligiblePsps).toEqual(['pspA', 'pspB']);

    const created = await call('POST', `/v1/mandates/${mandate.id}/debits`, { amountPaise: rs(499) }, apiKey, { 'idempotency-key': 'inv-2026-10' });
    expect(created.statusCode).toBe(201);
    const debit = created.json();
    expect(debit.state).toBe('SCHEDULED');
    expect(debit.requestedInPeak).toBe(true);
    expect(debit.noticeDate).toBe('2026-10-16');

    const replay = await call('POST', `/v1/mandates/${mandate.id}/debits`, { amountPaise: rs(499) }, apiKey, { 'idempotency-key': 'inv-2026-10' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(debit.id);

    clock.set(debit.scheduledAt);
    await ctx.worker.runOnce();
    const after = (await call('GET', `/v1/debits/${debit.id}`)).json();
    expect(after.state).toBe('SUCCEEDED');

    const savings = (await call('GET', '/v1/savings')).json();
    expect(savings.revenueProtectedPaise).toBe(rs(499));
  });

  it('Engine B: quote offers a discount-only NetBanking incentive and books the saving on accept', async () => {
    clock.set(ist('2026-10-15T14:00:00'));
    const quote = (await call('POST', '/v1/checkout/quote', { amountPaise: rs(5000) })).json();
    expect(quote.ruleSetId).toBe('npci-mdr-2026-10');
    expect(quote.offer).toEqual({ method: 'NETBANKING', discountPaise: rs(3), merchantNetSavingsPaise: rs(9) });
    const upi = quote.methods.find((m: { method: string }) => m.method === 'UPI');
    expect(upi.customerPayablePaise).toBe(rs(5000));

    const accepted = (await call('POST', `/v1/checkout/quotes/${quote.quoteId}/accept`, { method: 'NETBANKING' })).json();
    expect(accepted.steeringSavingsPaise).toBe(rs(9));
    const savings = (await call('GET', '/v1/savings')).json();
    expect(savings.feesSavedPaise).toBe(rs(9));
    expect(savings.byType.MDR_STEERING_OFFERED.count).toBe(1);

    const conflict = await call('POST', `/v1/checkout/quotes/${quote.quoteId}/accept`, { method: 'UPI' });
    expect(conflict.statusCode).toBe(409);
  });

  it('Engine B: before 15 Oct 2026 UPI is free, so no steering', async () => {
    clock.set(ist('2026-10-14T14:00:00'));
    const quote = (await call('POST', '/v1/checkout/quote', { amountPaise: rs(5000) })).json();
    expect(quote.ruleSetId).toBe('zero-mdr-legacy');
    expect(quote.offer).toBeUndefined();
  });

  it('Engine B: marketplace split by vendor ownership', async () => {
    await call('POST', '/v1/vendors', { externalId: 'potter', name: 'Village Pottery', smallMerchant: true });
    await call('POST', '/v1/vendors', { externalId: 'jeweller', name: 'Silver Works' });
    const res = await call('POST', '/v1/checkout/split', {
      lineItems: [
        { vendorId: 'potter', amountPaise: rs(2600) },
        { vendorId: 'jeweller', amountPaise: rs(2400) },
      ],
    });
    expect(res.statusCode).toBe(200);
    const split = res.json();
    expect(split.legs.map((l: { vendorId: string; mdrPaise: number }) => [l.vendorId, l.mdrPaise])).toEqual([
      ['potter', 0],
      ['jeweller', rs(9.6)],
    ]);
    const bad = await call('POST', '/v1/checkout/split', { lineItems: [{ vendorId: 'ghost', amountPaise: 100 }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('SPLIT_INVALID');
  });

  it('Phase 2: one-off payment fails over from a down PSP and reports recovery', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' });
    pspB.enqueue({ kind: 'SUCCESS', pspTxnId: 'B-777' });
    const res = await call('POST', '/v1/payments', { amountPaise: rs(2500), payerVpa: 'ravi@okicici', idempotencyKey: 'ord-1' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ state: 'SUCCEEDED', pspId: 'pspB', pspTxnId: 'B-777' });
    const savings = (await call('GET', '/v1/savings')).json();
    expect(savings.byType.TD_RECOVERED).toEqual({ count: 1, amountPaise: rs(2500) });
    const health = (await call('GET', '/v1/psps/health')).json();
    expect(health.data.map((p: { pspId: string }) => p.pspId)).toEqual(['pspA', 'pspB']);
  });

  it('Phase 3: a pending payment is resolved by the status poller; reads never call the PSP', async () => {
    pspA.enqueue({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } });
    const p = (await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okicici', idempotencyKey: 'ord-2' })).json();
    expect(p.state).toBe('PENDING');
    pspA.settle(`${p.id}-1`, { kind: 'SUCCESS', pspTxnId: 'A-1' });

    const callsBefore = pspA.calls.length;
    expect((await call('GET', `/v1/payments/${p.id}`)).json().state).toBe('PENDING');
    expect(pspA.calls.length).toBe(callsBefore);

    clock.advance(5_000);
    await ctx.poller.runOnce();
    expect((await call('GET', `/v1/payments/${p.id}`)).json().state).toBe('SUCCEEDED');
  });

  it('exposes the rule set in force for auditability', async () => {
    clock.set(ist('2026-10-20T12:00:00'));
    const rules = (await call('GET', '/v1/rules')).json();
    expect(rules.mdr.generalBps).toBe(40);
    expect(rules.windows.peak).toHaveLength(2);
  });
});
