import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../../src/psp/http.js';
import { RazorpayAdapter } from '../../src/psp/razorpay/adapter.js';
import { extractRefs } from '../../src/psp/razorpay/webhook.js';

const COLLECT = { kind: 'COLLECT' as const };
interface Req {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}
type Handler = (r: Req) => { status: number; body?: unknown } | 'TIMEOUT' | 'NETWORK';

function fakeRazorpay(routes: Record<string, Handler>, keyId = 'rzp_test_ABC123') {
  const requests: Req[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const u = new URL(url);
    const r: Req = { method: init.method, path: u.pathname.replace(/^\/v1/, ''), search: u.search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(r);
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === r.method && new RegExp(`^${p}$`).test(r.path);
    });
    const out = key ? routes[key]!(r) : { status: 404, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } } };
    if (out === 'TIMEOUT') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    if (out === 'NETWORK') throw new TypeError('fetch failed');
    const text = out.body === undefined ? '' : JSON.stringify(out.body);
    return { status: out.status, text: async () => text, headers: { get: () => null } };
  };
  const adapter = new RazorpayAdapter({ id: 'con_rzp', keyId, keySecret: 'rzp_secret_value', webhookSecret: 'whk_secret', fetch: fetchFn, log: () => {} });
  return { adapter, requests };
}

const noOrders: Handler = () => ({ status: 200, body: { items: [] } });
const order: Handler = (r) => ({ status: 200, body: { id: 'order_R1', receipt: (r.body as { receipt: string }).receipt, status: 'created' } });
const base = { txnRef: 'pay_1-1', amountPaise: 2_500_00, customerPhone: '9876543210' };

describe('RazorpayAdapter — one-off payments', () => {
  it('declares a one-off-only provider (no AutoPay through Merchantflo)', () => {
    const { adapter } = fakeRazorpay({});
    expect(adapter.mode).toBe('SANDBOX');
    expect(adapter.capabilities).toMatchObject({ autopay: false, channels: ['UPI_COLLECT', 'UPI_INTENT', 'NETBANKING', 'CARD'], collectRequires: ['customerPhone'] });
    expect(fakeRazorpay({}, 'rzp_live_X').adapter.mode).toBe('LIVE');
  });

  it('UPI intent: creates an order with our reference as receipt, then an S2S intent payment, returning the deeplink', async () => {
    const { adapter, requests } = fakeRazorpay({
      'GET /orders': noOrders,
      'POST /orders': order,
      'POST /payments/create/upi': () => ({ status: 200, body: { razorpay_payment_id: 'pay_RZ1', next: [{ action: 'intent', url: 'upi://pay?pa=rzp@icici&am=2500.00&tr=X' }, { action: 'poll', url: 'https://api.razorpay.com/v1/payments/pay_RZ1' }] } }),
    });
    const res = await adapter.collect({ ...base, channel: 'UPI_INTENT', client: { ip: '49.36.1.10', userAgent: 'Mozilla/5.0' } });
    expect(res).toEqual({ kind: 'PENDING', action: { type: 'UPI_INTENT', url: 'upi://pay?pa=rzp@icici&am=2500.00&tr=X', appUrls: {} } });
    expect(requests.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual(['GET /orders?receipt=pay_1-1&count=1', 'POST /orders', 'POST /payments/create/upi']);
    expect(requests[1]!.body).toEqual({ amount: 250000, currency: 'INR', receipt: 'pay_1-1', notes: { merchantflo_ref: 'pay_1-1' } });
    expect(requests[2]!.body).toMatchObject({ order_id: 'order_R1', amount: 250000, method: 'upi', upi: { flow: 'intent' }, contact: '9876543210', email: 'void@razorpay.com', ip: '49.36.1.10', user_agent: 'Mozilla/5.0' });
    expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_ABC123:rzp_secret_value').toString('base64')}`);
  });

  it('reuses the existing order on a retried reference instead of creating a second one', async () => {
    const { adapter, requests } = fakeRazorpay({
      'GET /orders': () => ({ status: 200, body: { items: [{ id: 'order_OLD', receipt: 'pay_1-1' }] } }),
      'GET /orders/order_OLD/payments': () => ({ status: 200, body: { items: [{ id: 'pay_failed', status: 'failed', created_at: 1 }] } }),
      'POST /payments/create/upi': () => ({ status: 200, body: { razorpay_payment_id: 'pay_RZ2', next: [{ action: 'poll', url: 'x' }] } }),
    });
    const res = await adapter.collect({ ...base, channel: 'UPI_COLLECT', payerVpa: 'asha@okhdfc' });
    expect(res).toEqual({ kind: 'PENDING', action: { type: 'UPI_COLLECT', vpa: 'asha@okhdfc' } });
    expect(requests.filter((r) => r.path === '/orders' && r.method === 'POST')).toHaveLength(0);
    expect(requests.at(-1)!.body).toMatchObject({ order_id: 'order_OLD', upi: { flow: 'collect', vpa: 'asha@okhdfc' } });
  });

  it('never sends a second UPI request while an earlier one on the same order is still live', async () => {
    const { adapter, requests } = fakeRazorpay({
      'GET /orders': () => ({ status: 200, body: { items: [{ id: 'order_OLD', receipt: 'pay_1-1' }] } }),
      'GET /orders/order_OLD/payments': () => ({ status: 200, body: { items: [{ id: 'pay_live', status: 'created', created_at: 1 }] } }),
    });
    expect(await adapter.collect({ ...base, channel: 'UPI_COLLECT', payerVpa: 'asha@okhdfc' })).toEqual({ kind: 'PENDING', action: { type: 'UPI_COLLECT', vpa: 'asha@okhdfc' } });
    expect(await adapter.collect({ ...base, channel: 'UPI_INTENT' })).toEqual({ kind: 'PENDING' });
    expect(requests.some((r) => r.path === '/payments/create/upi')).toBe(false);
  });

  it('a captured attempt decides the order even when a later attempt failed; the debit of a timed-out payment is unknown', async () => {
    const order = { 'GET /orders': () => ({ status: 200, body: { items: [{ id: 'order_R1', receipt: 'pay_1-1' }] } }) };
    const late = fakeRazorpay({
      ...order,
      'GET /orders/order_R1/payments': () => ({ status: 200, body: { items: [{ id: 'pay_ok', status: 'captured', captured: true, created_at: 1 }, { id: 'pay_retry', status: 'failed', error_source: 'customer', created_at: 9 }] } }),
    }).adapter;
    expect(await late.status('pay_1-1', COLLECT)).toEqual({ kind: 'SUCCESS', pspTxnId: 'pay_ok' });
    const timedOut = fakeRazorpay({
      ...order,
      'GET /orders/order_R1/payments': () => ({ status: 200, body: { items: [{ id: 'pay_t', status: 'failed', error_source: 'customer', error_reason: 'payment_timed_out', created_at: 1 }] } }),
    }).adapter;
    expect(await timedOut.status('pay_1-1', COLLECT)).toEqual({ kind: 'BUSINESS_DECLINE', code: 'OTHER' }); // never failed over
    expect(await timedOut.inquire('pay_1-1', COLLECT)).toMatchObject({ outcome: 'FAILED', customerDebit: 'UNKNOWN' }); // still watched
  });

  it('cards and netbanking open Razorpay Checkout with the order — nothing card-related passes through us', async () => {
    const { adapter, requests } = fakeRazorpay({ 'GET /orders': noOrders, 'POST /orders': order });
    expect(await adapter.collect({ ...base, channel: 'CARD' })).toEqual({
      kind: 'PENDING',
      action: { type: 'PSP_CHECKOUT', provider: 'razorpay', environment: 'sandbox', params: { keyId: 'rzp_test_ABC123', orderId: 'order_R1', method: 'card' } },
    });
    expect(requests.some((r) => r.path.startsWith('/payments'))).toBe(false);
  });

  it('maps request errors: customer problems are declines, outages and timeouts are technical', async () => {
    const run = (h: Handler) => fakeRazorpay({ 'GET /orders': noOrders, 'POST /orders': order, 'POST /payments/create/upi': h }).adapter.collect({ ...base, channel: 'UPI_COLLECT', payerVpa: 'asha@okhdfc' });
    expect(await run(() => ({ status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid VPA', source: 'customer', reason: 'invalid_vpa' } } }))).toEqual({ kind: 'BUSINESS_DECLINE', code: 'OTHER' });
    expect(await run(() => ({ status: 502, body: {} }))).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' });
    expect(await run(() => 'TIMEOUT')).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' });
    expect(await run(() => 'NETWORK')).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' });
  });
});

describe('RazorpayAdapter — status and money facts', () => {
  const withPayments = (items: unknown[], refunds: unknown[] = []) =>
    fakeRazorpay({
      'GET /orders': () => ({ status: 200, body: { items: [{ id: 'order_R1', receipt: 'pay_1-1' }] } }),
      'GET /orders/order_R1/payments': () => ({ status: 200, body: { items } }),
      'GET /payments/pay_RZ/refunds': () => ({ status: 200, body: { items: refunds } }),
    }).adapter;

  it('captured → success with the UPI reference; authorized → pending but debited; no order → not found', async () => {
    const captured = withPayments([{ id: 'pay_RZ', status: 'captured', captured: true, created_at: 2, acquirer_data: { rrn: '412345678901' } }]);
    expect(await captured.status('pay_1-1', COLLECT)).toEqual({ kind: 'SUCCESS', pspTxnId: 'pay_RZ', upiRrn: '412345678901' });
    expect(await captured.inquire('pay_1-1', COLLECT)).toMatchObject({ outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', upiRrn: '412345678901' });
    const authorized = withPayments([{ id: 'pay_RZ', status: 'authorized', created_at: 2 }]);
    expect(await authorized.status('pay_1-1', COLLECT)).toEqual({ kind: 'PENDING' });
    expect(await authorized.inquire('pay_1-1', COLLECT)).toMatchObject({ outcome: 'PENDING', customerDebit: 'DEBITED', capture: 'UNKNOWN' });
    const none = fakeRazorpay({ 'GET /orders': noOrders }).adapter;
    expect(await none.status('pay_1-1', COLLECT)).toEqual({ kind: 'NOT_FOUND' });
    expect(await none.inquire('pay_1-1', COLLECT)).toEqual({ found: false });
  });

  it('uses the latest attempt, and tells customer declines from bank failures', async () => {
    const declined = withPayments([
      { id: 'pay_old', status: 'failed', error_source: 'bank', error_reason: 'server_error', created_at: 1 },
      { id: 'pay_RZ', status: 'failed', error_source: 'customer', error_reason: 'insufficient_funds', created_at: 5 },
    ]);
    expect(await declined.status('pay_1-1', COLLECT)).toEqual({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
    expect(await declined.inquire('pay_1-1', COLLECT)).toMatchObject({ outcome: 'FAILED', customerDebit: 'NOT_DEBITED' });
    const bank = withPayments([{ id: 'pay_RZ', status: 'failed', error_source: 'bank', error_reason: 'payment_failed', error_code: 'BAD_REQUEST_ERROR', created_at: 1 }]);
    expect(await bank.status('pay_1-1', COLLECT)).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' });
    expect(await bank.inquire('pay_1-1', COLLECT)).toMatchObject({ outcome: 'FAILED', customerDebit: 'UNKNOWN', failureCode: 'BAD_REQUEST_ERROR' });
  });

  it('an uncaptured payment Razorpay refunded is a reversal of a debited payment', async () => {
    const reversed = withPayments([{ id: 'pay_RZ', status: 'refunded', captured: false, created_at: 1 }], [{ id: 'rfnd_1', status: 'processed', created_at: 1760500000 }]);
    expect(await reversed.inquire('pay_1-1', COLLECT)).toMatchObject({
      outcome: 'FAILED',
      customerDebit: 'DEBITED',
      capture: 'NOT_CAPTURED',
      reversal: { status: 'COMPLETED', completedAt: new Date(1760500000 * 1000) },
    });
    const inFlight = withPayments([{ id: 'pay_RZ', status: 'refunded', captured: false, created_at: 1 }], [{ id: 'rfnd_1', status: 'pending', created_at: 1760500000 }]);
    expect((await inFlight.inquire('pay_1-1', COLLECT)) as { reversal: unknown }).toMatchObject({ reversal: { status: 'INITIATED' } });
  });

  it('throws when a lookup fails, so callers record "couldn\'t check" rather than an answer', async () => {
    const { adapter } = fakeRazorpay({ 'GET /orders': () => ({ status: 503, body: { error: { code: 'SERVER_ERROR' } } }) });
    await expect(adapter.status('pay_1-1', COLLECT)).rejects.toThrow(/Razorpay lookup failed: HTTP 503/);
  });
});

describe('RazorpayAdapter — account and webhooks', () => {
  it('checks keys with an order listing', async () => {
    expect(await fakeRazorpay({ 'GET /orders': noOrders }).adapter.checkCredentials()).toEqual({ ok: true });
    expect(await fakeRazorpay({ 'GET /orders': () => ({ status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } }) }).adapter.checkCredentials()).toMatchObject({ ok: false, rejected: true });
  });

  it('verifies X-Razorpay-Signature and extracts our references', () => {
    const { adapter } = fakeRazorpay({});
    const raw = JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: 'order_R1', receipt: 'pay_1-1' } }, payment: { entity: { id: 'pay_RZ', notes: { merchantflo_ref: 'pay_1-1' } } } } });
    const sig = createHmac('sha256', 'whk_secret').update(raw).digest('hex');
    expect(adapter.verifyWebhook(raw, { 'x-razorpay-signature': sig })).toEqual({ ok: true, refs: ['pay_1-1'] });
    expect(adapter.verifyWebhook(raw.replace('pay_1-1', 'pay_2-1'), { 'x-razorpay-signature': sig })).toEqual({ ok: false, reason: 'bad signature' });
    expect(adapter.verifyWebhook(raw, {})).toEqual({ ok: false, reason: 'missing signature header' });
    expect(extractRefs('not json')).toEqual([]);
  });
});

describe('RazorpayAdapter — settlement reconciliation', () => {
  const SETTLED_AT = Math.floor(Date.parse('2026-10-16T04:30:00Z') / 1000);
  it('reads the combined recon report day by day (IST), paging with skip', async () => {
    const days: string[] = [];
    const { adapter } = fakeRazorpay({
      'GET /settlements/recon/combined': (r) => {
        const q = new URLSearchParams(r.search);
        days.push(`${q.get('year')}-${q.get('month')}-${q.get('day')}:${q.get('skip')}`);
        if (q.get('day') !== '16') return { status: 200, body: { items: [] } };
        return {
          status: 200,
          body: {
            items: [
              { entity_id: 'pay_RZ', type: 'payment', amount: 250000, fee: 1000, tax: 180, credit: 248820, debit: 0, settled: true, settled_at: SETTLED_AT, settlement_id: 'setl_1', settlement_utr: 'UTRR1' },
              { entity_id: 'rfnd_1', type: 'refund', amount: 50000, credit: 0, debit: 50000, payment_id: 'pay_OLD', settled: true, settled_at: SETTLED_AT, settlement_id: 'setl_1' },
              { entity_id: 'pay_LATER', type: 'payment', amount: 100, settled: false },
            ],
          },
        };
      },
    });
    const lines = await adapter.settlements({ from: new Date('2026-10-15T18:30:00Z'), to: new Date('2026-10-16T18:30:00Z') });
    expect(days).toEqual(['2026-10-16:0']);
    expect(lines).toEqual([
      { pspEventId: 'payment:pay_RZ:setl_1', kind: 'PAYMENT', pspPaymentId: 'pay_RZ', orderRef: null, amountPaise: 250000, feePaise: 1000, taxPaise: 180, settledAmountPaise: 248820, settlementId: 'setl_1', utr: 'UTRR1', settledAt: new Date(SETTLED_AT * 1000) },
      expect.objectContaining({ kind: 'REFUND', pspPaymentId: 'pay_OLD', settledAmountPaise: -50000 }),
    ]);
  });
});
