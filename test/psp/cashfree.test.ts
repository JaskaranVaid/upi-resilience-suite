import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CashfreeAdapter, CASHFREE_API_VERSION } from '../../src/psp/cashfree/adapter.js';
import { classifyFailure, customerIdFor, idempotencyKey, inquiryFromOrder, mapOrderPayment } from '../../src/psp/cashfree/mapping.js';
import { verifyCashfreeWebhook } from '../../src/psp/cashfree/webhook.js';
import type { FetchFn } from '../../src/psp/http.js';

const SECRET = 'cfsk_test_secret_value';
const MANDATE = { kind: 'MANDATE' as const, mandateRef: 'sub_42', noticeRef: 'dbt_1' };
const COLLECT = { kind: 'COLLECT' as const };

interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
type Handler = (req: Recorded) => { status: number; body?: unknown } | 'TIMEOUT' | 'NETWORK';

/** In-process fake Cashfree: routes by "METHOD /path", records every request. */
function fakeCashfree(routes: Record<string, Handler | Array<Handler>>) {
  const requests: Recorded[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const fetchFn: FetchFn = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/pg/, '');
    const req: Recorded = { method: init.method, url, path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(req);
    const key = [...queues.keys()].find((k) => {
      const [m, p] = k.split(' ');
      return m === init.method && new RegExp(`^${p}$`).test(path);
    });
    const entry = key ? queues.get(key)! : undefined;
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    const out = handler ? handler(req) : { status: 404, body: { message: 'not found', code: 'resource_not_found' } };
    if (out === 'TIMEOUT') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (out === 'NETWORK') throw new TypeError('fetch failed');
    const text = out.body === undefined ? '' : JSON.stringify(out.body);
    return { status: out.status, text: async () => text, headers: { get: () => null } };
  };
  const logs: string[] = [];
  const adapter = new CashfreeAdapter({ clientId: 'CF_APP_1', clientSecret: SECRET, env: 'sandbox', fetch: fetchFn, log: (m, meta) => logs.push(m + JSON.stringify(meta ?? {})) });
  return { adapter, requests, logs };
}

describe('CashfreeAdapter — configuration', () => {
  it('declares what Cashfree can and cannot do', () => {
    const { adapter } = fakeCashfree({});
    expect(adapter.id).toBe('cashfree');
    expect(adapter.mode).toBe('SANDBOX');
    expect(adapter.capabilities).toEqual({
      minNoticeMs: 25 * 3600_000,
      maxNoticeLeadMs: 6 * 24 * 3600_000,
      udirComplaints: false,
      portableMandates: false,
      collectRequires: ['customerPhone'],
      channels: ['UPI_COLLECT'],
    });
  });

  it('targets production only when configured, and refuses to start without credentials', () => {
    expect(new CashfreeAdapter({ clientId: 'a', clientSecret: 'b', env: 'production' }).mode).toBe('LIVE');
    expect(() => new CashfreeAdapter({ clientId: '', clientSecret: 'b', env: 'sandbox' })).toThrow();
  });
});

describe('CashfreeAdapter — UPI AutoPay (controlled flow)', () => {
  it('sends the pre-debit notification with the documented request', async () => {
    const { adapter, requests } = fakeCashfree({ 'POST /subscriptions/pay/controlled/notify-mandate': () => ({ status: 200, body: { notification_status: 'INITIALIZED' } }) });
    const res = await adapter.sendPreDebitNotice({ noticeRef: 'dbt_1', mandateRef: 'sub_42', amountPaise: 49_900, executionDate: '2026-10-17' });
    expect(res).toEqual({ ok: true });
    const r = requests[0]!;
    expect(r.url).toBe('https://sandbox.cashfree.com/pg/subscriptions/pay/controlled/notify-mandate');
    expect(r.headers).toMatchObject({ 'x-api-version': CASHFREE_API_VERSION, 'x-client-id': 'CF_APP_1', 'x-client-secret': SECRET, 'content-type': 'application/json' });
    expect(r.headers['x-idempotency-key']).toBe(idempotencyKey('notify', 'dbt_1-n-2026-10-17'));
    expect(r.body).toEqual({
      subscription_id: 'sub_42',
      payment_id: 'dbt_1',
      notification_id: 'dbt_1-n-2026-10-17',
      payment_amount: 499,
      payment_schedule_date: '2026-10-17T00:00:00+05:30',
      payment_remarks: 'Upcoming AutoPay debit',
    });
  });

  it('reports a refused notification with the reason, never the secret', async () => {
    const { adapter } = fakeCashfree({ 'POST /subscriptions/pay/controlled/notify-mandate': () => ({ status: 400, body: { code: 'Prev_PDN_In_Progress', message: 'Previous PDN is in progress' } }) });
    const res = await adapter.sendPreDebitNotice({ noticeRef: 'dbt_1', mandateRef: 'sub_42', amountPaise: 100, executionDate: '2026-10-17' });
    expect(res).toEqual({ ok: false, reason: 'HTTP 400 Prev_PDN_In_Progress: Previous PDN is in progress' });
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('executes against the notified base payment with a deterministic idempotency key', async () => {
    const { adapter, requests } = fakeCashfree({
      'POST /subscriptions/pay/controlled/execute-mandate': () => ({ status: 200, body: { execution_status: 'INITIALIZED', payment_status: 'INITIALIZED' } }),
    });
    const req = { txnRef: 'dbt_1-a1-1', mandateRef: 'sub_42', amountPaise: 49_900, noticeRef: 'dbt_1' };
    expect(await adapter.executeMandate(req)).toEqual({ kind: 'PENDING' });
    await adapter.executeMandate(req); // the router's same-txnRef retry
    expect(requests.map((r) => r.body)).toEqual([
      { payment_id: 'dbt_1', execution_id: 'dbt_1-a1-1' },
      { payment_id: 'dbt_1', execution_id: 'dbt_1-a1-1' },
    ]);
    expect(requests[0]!.headers['x-idempotency-key']).toBe(requests[1]!.headers['x-idempotency-key']); // Cashfree replays, no double debit
  });

  it.each([
    ['success', { status: 200, body: { payment_status: 'SUCCESS', cf_txn_id: 98765 } }, { kind: 'SUCCESS', pspTxnId: '98765' }],
    ['insufficient funds', { status: 200, body: { payment_status: 'FAILED', failure_details: { failure_reason: 'DEBIT FAILED | Insufficient Funds' } } }, { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' }],
    ['unrecognised failure', { status: 200, body: { payment_status: 'FAILED', failure_details: { failure_reason: 'Issuer bank not reachable' } } }, { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }],
    ['undocumented status', { status: 200, body: { payment_status: 'SOMETHING_NEW' } }, { kind: 'PENDING' }],
    ['previous execution in progress', { status: 400, body: { code: 'Prev_Execution_In_Progress', message: 'Previous Execution is in progress' } }, { kind: 'PENDING' }],
    ['max executions reached', { status: 400, body: { code: 'payment_execution_restriction_error', message: 'Max number of executions for a payment reached' } }, { kind: 'BUSINESS_DECLINE', code: 'LIMIT_EXCEEDED' }],
    ['no successful notification', { status: 400, body: { code: 'payment_execution_restriction_error', message: 'No successful notification for payment_id' } }, { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }],
    ['other rejection', { status: 400, body: { code: 'request_invalid', message: 'subscription_id is invalid' } }, { kind: 'BUSINESS_DECLINE', code: 'OTHER' }],
    ['rate limited', { status: 429, body: {} }, { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }],
    ['server error', { status: 503, body: {} }, { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }],
  ] as const)('maps execution: %s', async (_name, response, expected) => {
    const { adapter } = fakeCashfree({ 'POST /subscriptions/pay/controlled/execute-mandate': () => response });
    expect(await adapter.executeMandate({ txnRef: 't', mandateRef: 'sub_42', amountPaise: 100, noticeRef: 'dbt_1' })).toEqual(expected);
  });

  it('turns transport failures into technical declines the router knows how to handle', async () => {
    const t = fakeCashfree({ 'POST /subscriptions/pay/controlled/execute-mandate': () => 'TIMEOUT' });
    expect(await t.adapter.executeMandate({ txnRef: 't', mandateRef: 'm', amountPaise: 1, noticeRef: 'n' })).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' });
    const n = fakeCashfree({ 'POST /subscriptions/pay/controlled/execute-mandate': () => 'NETWORK' });
    expect(await n.adapter.executeMandate({ txnRef: 't', mandateRef: 'm', amountPaise: 1, noticeRef: 'n' })).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' });
  });

  it('flags rejected credentials loudly without logging them', async () => {
    const { adapter, logs } = fakeCashfree({ 'POST /subscriptions/pay/controlled/execute-mandate': () => ({ status: 401, body: { message: 'authentication Failed' } }) });
    expect(await adapter.executeMandate({ txnRef: 't', mandateRef: 'm', amountPaise: 1, noticeRef: 'n' })).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' });
    expect(logs.join(' ')).toMatch(/rejected the credentials/);
    expect(logs.join(' ')).not.toContain(SECRET);
  });

  it('looks executions up by base payment + execution id', async () => {
    const { adapter, requests } = fakeCashfree({
      'GET /subscriptions/payments/dbt_1/controlled/executions/dbt_1-a1-1': () => ({ status: 200, body: { payment_status: 'SUCCESS', cf_txn_id: 5 } }),
    });
    expect(await adapter.status('dbt_1-a1-1', MANDATE)).toEqual({ kind: 'SUCCESS', pspTxnId: '5' });
    expect(await adapter.status('dbt_1-a9-9', MANDATE)).toEqual({ kind: 'NOT_FOUND' });
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers['x-idempotency-key']).toBeUndefined();
  });

  it('inquires executions: success, customer-side failure, unknown failure', async () => {
    const { adapter } = fakeCashfree({
      'GET /subscriptions/payments/dbt_1/controlled/executions/ok': () => ({ status: 200, body: { payment_status: 'SUCCESS' } }),
      'GET /subscriptions/payments/dbt_1/controlled/executions/funds': () => ({ status: 200, body: { payment_status: 'FAILED', failure_details: { failure_reason: 'Insufficient Funds', failure_error_code: 'Z9' } } }),
      'GET /subscriptions/payments/dbt_1/controlled/executions/odd': () => ({ status: 200, body: { payment_status: 'FAILED', failure_details: { failure_reason: 'Bank timeout' } } }),
    });
    expect(await adapter.inquire('ok', MANDATE)).toMatchObject({ outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED' });
    expect(await adapter.inquire('funds', MANDATE)).toMatchObject({ outcome: 'FAILED', customerDebit: 'NOT_DEBITED', failureCode: 'Z9' });
    expect(await adapter.inquire('odd', MANDATE)).toMatchObject({ outcome: 'FAILED', customerDebit: 'UNKNOWN' });
    expect(await adapter.inquire('missing', MANDATE)).toEqual({ found: false });
  });
});

describe('CashfreeAdapter — UPI collect', () => {
  const ORDER = { status: 200, body: { order_id: 'pay_1-1', order_status: 'ACTIVE', payment_session_id: 'session_abc' } };

  it('creates an order then sends a collect request to the payer VPA', async () => {
    const { adapter, requests } = fakeCashfree({
      'POST /orders': () => ORDER,
      'POST /orders/sessions': () => ({ status: 200, body: { cf_payment_id: 1, payment_method: 'upi', channel: 'collect', action: 'custom' } }),
    });
    const res = await adapter.collect({ channel: 'UPI_COLLECT', txnRef: 'pay_1-1', payerVpa: 'asha@okhdfc', amountPaise: 250_000, customerPhone: '9876543210' });
    expect(res).toEqual({ kind: 'PENDING' }); // the customer approves in their UPI app
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /orders', 'POST /orders/sessions']);
    expect(requests[0]!.body).toEqual({
      order_id: 'pay_1-1',
      order_amount: 2500,
      order_currency: 'INR',
      customer_details: { customer_id: customerIdFor('asha@okhdfc'), customer_phone: '9876543210' },
    });
    expect(requests[1]!.body).toEqual({ payment_session_id: 'session_abc', payment_method: { upi: { channel: 'collect', upi_id: 'asha@okhdfc' } } });
    expect(requests[1]!.headers).toMatchObject({ 'x-client-device': 'mobile' });
    expect(customerIdFor('asha@okhdfc')).toMatch(/^[a-z0-9]{3,50}$/);
  });

  it('reuses an order created by an earlier attempt with the same reference', async () => {
    const { adapter, requests } = fakeCashfree({
      'POST /orders': () => ({ status: 409, body: { code: 'order_already_exists', message: 'order with same id is already present' } }),
      'GET /orders/pay_1-1': () => ORDER,
      'POST /orders/sessions': () => ({ status: 200, body: {} }),
    });
    expect(await adapter.collect({ channel: 'UPI_COLLECT', txnRef: 'pay_1-1', payerVpa: 'ab@ok', amountPaise: 100, customerPhone: '9876543210' })).toEqual({ kind: 'PENDING' });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /orders', 'GET /orders/pay_1-1', 'POST /orders/sessions']);
  });

  it('declines locally when the customer phone Cashfree requires is missing', async () => {
    const { adapter, requests } = fakeCashfree({});
    expect(await adapter.collect({ channel: 'UPI_COLLECT', txnRef: 'p', payerVpa: 'ab@ok', amountPaise: 100 })).toEqual({ kind: 'BUSINESS_DECLINE', code: 'OTHER' });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['success', [{ payment_status: 'SUCCESS', cf_payment_id: 7, bank_reference: '612345678901', payment_time: '2026-10-15T10:00:00+05:30' }], { kind: 'SUCCESS', pspTxnId: '7', upiRrn: '612345678901' }],
    ['pending', [{ payment_status: 'PENDING' }], { kind: 'PENDING' }],
    ['not attempted', [{ payment_status: 'NOT_ATTEMPTED' }], { kind: 'PENDING' }],
    ['user dropped', [{ payment_status: 'USER_DROPPED' }], { kind: 'BUSINESS_DECLINE', code: 'OTHER' }],
    ['customer-side failure', [{ payment_status: 'FAILED', error_details: { error_source: 'customer', error_reason: 'payment_declined' } }], { kind: 'BUSINESS_DECLINE', code: 'OTHER' }],
    ['bank-side failure', [{ payment_status: 'FAILED', error_details: { error_source: 'bank', error_reason: 'bank_unavailable' } }], { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' }],
    [
      'latest attempt wins',
      [
        { payment_status: 'FAILED', payment_time: '2026-10-15T10:00:00+05:30', error_details: { error_source: 'bank' } },
        { payment_status: 'SUCCESS', cf_payment_id: 9, payment_time: '2026-10-15T10:05:00+05:30' },
      ],
      { kind: 'SUCCESS', pspTxnId: '9' },
    ],
  ] as const)('maps order status: %s', async (_n, payments, expected) => {
    const { adapter } = fakeCashfree({ 'GET /orders/pay_1-1/payments': () => ({ status: 200, body: payments }) });
    expect(await adapter.status('pay_1-1', COLLECT)).toEqual(expected);
  });

  it('reports NOT_FOUND for an unknown order or one with no payment attempt', async () => {
    const { adapter } = fakeCashfree({ 'GET /orders/empty/payments': () => ({ status: 200, body: [] }) });
    expect(await adapter.status('empty', COLLECT)).toEqual({ kind: 'NOT_FOUND' });
    expect(await adapter.status('nope', COLLECT)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('throws on failed lookups so callers record "could not check" rather than an answer', async () => {
    const { adapter } = fakeCashfree({ 'GET /orders/x/payments': () => ({ status: 500, body: { message: 'oops' } }) });
    await expect(adapter.status('x', COLLECT)).rejects.toThrow(/HTTP 500/);
    await expect(adapter.inquire('x', COLLECT)).rejects.toThrow(/HTTP 500/);
  });
});

describe('CashfreeAdapter — inquiry and auto-refunds (debited but failed)', () => {
  const failedBank = [{ payment_status: 'FAILED', bank_reference: '612345678901', error_details: { error_source: 'bank', error_code: 'TXN_FAILED' } }];
  const inquire = async (payments: unknown[], refunds: unknown[] | null) => {
    const { adapter } = fakeCashfree({
      'GET /orders/o/payments': () => ({ status: 200, body: payments }),
      ...(refunds ? { 'GET /orders/o/refunds': () => ({ status: 200, body: refunds }) } : {}),
    });
    return adapter.inquire('o', COLLECT);
  };

  it('success: debited and captured, with the UPI reference', async () => {
    expect(await inquire([{ payment_status: 'SUCCESS', bank_reference: '612345678901', is_captured: true }], [])).toEqual({
      found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' }, upiRrn: '612345678901',
    });
  });

  it('bank-side failure without an auto-refund: debit unknown (watched)', async () => {
    expect(await inquire(failedBank, [])).toMatchObject({ outcome: 'FAILED', customerDebit: 'UNKNOWN', capture: 'NOT_CAPTURED', failureCode: 'TXN_FAILED' });
  });

  it('customer-side failure: not debited', async () => {
    expect(await inquire([{ payment_status: 'FAILED', error_details: { error_source: 'customer' } }], [])).toMatchObject({ customerDebit: 'NOT_DEBITED' });
    expect(await inquire([{ payment_status: 'USER_DROPPED' }], null)).toMatchObject({ customerDebit: 'NOT_DEBITED' });
  });

  it('auto-refund in flight: debited, reversal initiated', async () => {
    expect(await inquire(failedBank, [{ refund_type: 'PAYMENT_AUTO_REFUND', refund_status: 'PENDING', created_at: '2026-10-15T11:00:00+05:30' }])).toMatchObject({
      outcome: 'FAILED', customerDebit: 'DEBITED', reversal: { status: 'INITIATED', initiatedAt: new Date('2026-10-15T11:00:00+05:30') },
    });
  });

  it('auto-refund processed: reversal completed with timestamps', async () => {
    expect(await inquire(failedBank, [{ refund_type: 'UNRECONCILED_AUTO_REFUND', refund_status: 'SUCCESS', created_at: '2026-10-15T11:00:00+05:30', processed_at: '2026-10-16T09:00:00+05:30' }])).toMatchObject({
      customerDebit: 'DEBITED', reversal: { status: 'COMPLETED', initiatedAt: new Date('2026-10-15T11:00:00+05:30'), completedAt: new Date('2026-10-16T09:00:00+05:30') },
    });
  });

  it('a rejected auto-refund needs a human (reversal unknown); merchant refunds are ignored', async () => {
    expect(await inquire(failedBank, [{ refund_type: 'PAYMENT_AUTO_REFUND', refund_status: 'REJECTED' }])).toMatchObject({ reversal: { status: 'UNKNOWN' } });
    expect(await inquire(failedBank, [{ refund_type: 'MERCHANT_INITIATED', refund_status: 'SUCCESS' }])).toMatchObject({ customerDebit: 'UNKNOWN', reversal: { status: 'NONE' } });
  });

  it('pure mapping agrees with the adapter path', () => {
    expect(inquiryFromOrder([], [])).toEqual({ found: false });
  });
});

/**
 * Real responses from the Cashfree sandbox (API 2026-01-01), recorded 2026-10-06 with the published
 * test VPAs (testsuccess / testfailure / testinsufficientfunds / testtimeoutbank @gocash).
 * Only the fields the mapping reads are kept, verbatim.
 */
describe('Cashfree mapping — recorded sandbox responses', () => {
  const failed = (error_details: Record<string, string>, cf_payment_id: string, payment_time: string) => ({
    payment_status: 'FAILED', cf_payment_id, bank_reference: '1234567890', is_captured: false, payment_time, error_details,
  });
  it.each([
    [
      'testsuccess@gocash',
      { payment_status: 'SUCCESS', cf_payment_id: '1461039309445300736', bank_reference: '1234567890', is_captured: true, payment_time: '2026-10-06T22:18:36+05:30', error_details: null },
      { kind: 'SUCCESS', pspTxnId: '1461039309445300736', upiRrn: '1234567890' },
      { outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED' },
    ],
    [
      'testfailure@gocash',
      failed({ error_code: 'TRANSACTION_DECLINED', error_description: 'Issue originating from user. Request user to try again', error_reason: 'decline_originating_from_user', error_source: 'customer', error_code_raw: 'U30' }, '1461039501695418880', '2026-10-06T22:19:22+05:30'),
      { kind: 'BUSINESS_DECLINE', code: 'OTHER' },
      { outcome: 'FAILED', customerDebit: 'NOT_DEBITED', failureCode: 'TRANSACTION_DECLINED' },
    ],
    [
      'testinsufficientfunds@gocash',
      failed({ error_code: 'CUSTOMER_AUTH_FAILURE', error_description: "Insufficient funds in user's account, request user to retry after adding funds", error_reason: 'insufficient_funds', error_source: 'customer', error_code_raw: 'U30', error_subcode_raw: 'Z9' }, '1461039521714411008', '2026-10-06T22:19:27+05:30'),
      { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' },
      { outcome: 'FAILED', customerDebit: 'NOT_DEBITED', failureCode: 'CUSTOMER_AUTH_FAILURE' },
    ],
    [
      'testtimeoutbank@gocash',
      failed({ error_code: 'TECHNICAL_FAILURE', error_description: 'Transaction failed because issuing bank did not respond in time. Request user to try again', error_reason: 'high_response_time_from_issuing_bank', error_source: 'issuing_bank', error_code_raw: 'U90' }, '1461039518677734912', '2026-10-06T22:19:26+05:30'),
      { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' },
      { outcome: 'FAILED', customerDebit: 'UNKNOWN', failureCode: 'TECHNICAL_FAILURE' },
    ],
  ] as const)('%s', (_vpa, payment, status, inquiry) => {
    expect(mapOrderPayment(payment)).toEqual(status);
    expect(inquiryFromOrder([payment], [])).toMatchObject({ found: true, ...inquiry, reversal: { status: 'NONE' } });
  });

  it('keeps 19-digit Cashfree ids exact (they arrive as JSON strings)', () => {
    const [p] = JSON.parse('[{"payment_status":"SUCCESS","cf_payment_id":"1461039309445300736"}]');
    expect(mapOrderPayment(p)).toMatchObject({ pspTxnId: '1461039309445300736' });
  });
});

describe('Cashfree mapping helpers', () => {
  it.each([
    ['DEBIT FAILED | Insufficient Funds', { kind: 'BUSINESS', code: 'INSUFFICIENT_FUNDS' }],
    ['Mandate revoked by customer', { kind: 'BUSINESS', code: 'MANDATE_REVOKED' }],
    ['Mandate paused', { kind: 'BUSINESS', code: 'MANDATE_REVOKED' }],
    ['Transaction limit exceeded', { kind: 'BUSINESS', code: 'LIMIT_EXCEEDED' }],
    ['Incorrect UPI PIN', { kind: 'BUSINESS', code: 'WRONG_PIN' }],
    ['Collect request expired', { kind: 'BUSINESS', code: 'OTHER' }],
    ['Issuer bank not reachable', { kind: 'TECHNICAL' }],
    [null, { kind: 'TECHNICAL' }],
  ] as const)('classifyFailure(%j)', (reason, expected) => {
    expect(classifyFailure(reason)).toEqual(expected);
  });

  it('idempotency keys are stable, distinct per operation, and UUID-shaped', () => {
    const k = idempotencyKey('execute', 'dbt_1-a1-1');
    expect(k).toBe(idempotencyKey('execute', 'dbt_1-a1-1'));
    expect(k).not.toBe(idempotencyKey('execute', 'dbt_1-a1-2'));
    expect(k).not.toBe(idempotencyKey('notify', 'dbt_1-a1-1'));
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('Cashfree webhook verification', () => {
  const now = new Date('2026-10-15T08:00:00Z');
  const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'pay_1-1' }, payment: { payment_status: 'SUCCESS' } } });
  const sign = (ts: string, raw: string, secret = SECRET) => createHmac('sha256', secret).update(ts + raw).digest('base64');
  const ts = String(now.getTime());

  it('accepts a correctly signed, fresh webhook and extracts our references', () => {
    expect(verifyCashfreeWebhook(SECRET, body, { 'x-webhook-signature': sign(ts, body), 'x-webhook-timestamp': ts }, now)).toEqual({ ok: true, refs: ['pay_1-1'] });
  });

  it('rejects a tampered body, a wrong secret, missing headers and stale timestamps', () => {
    expect(verifyCashfreeWebhook(SECRET, body.replace('SUCCESS', 'FAILED'), { 'x-webhook-signature': sign(ts, body), 'x-webhook-timestamp': ts }, now)).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(verifyCashfreeWebhook(SECRET, body, { 'x-webhook-signature': sign(ts, body, 'other'), 'x-webhook-timestamp': ts }, now)).toMatchObject({ ok: false });
    expect(verifyCashfreeWebhook(SECRET, body, {}, now)).toMatchObject({ ok: false, reason: 'missing signature headers' });
    const old = String(now.getTime() - 10 * 60_000);
    expect(verifyCashfreeWebhook(SECRET, body, { 'x-webhook-signature': sign(old, body), 'x-webhook-timestamp': old }, now)).toMatchObject({ ok: false, reason: 'stale timestamp' });
  });

  it('accepts second-resolution timestamps and finds references in refund and subscription events', () => {
    const secs = String(Math.floor(now.getTime() / 1000));
    const refund = JSON.stringify({ type: 'AUTO_REFUND_STATUS_WEBHOOK', data: { order_id: 'pay_2-1', refund_status: 'SUCCESS' } });
    expect(verifyCashfreeWebhook(SECRET, refund, { 'x-webhook-signature': sign(secs, refund), 'x-webhook-timestamp': secs }, now)).toEqual({ ok: true, refs: ['pay_2-1'] });
    const exec = JSON.stringify({ type: 'SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS', data: { execution_id: 'dbt_1-a1-1', payment_id: 'dbt_1' } });
    expect(verifyCashfreeWebhook(SECRET, exec, { 'x-webhook-signature': sign(ts, exec), 'x-webhook-timestamp': ts }, now)).toEqual({ ok: true, refs: ['dbt_1-a1-1', 'dbt_1'] });
  });
});

describe('CashfreeAdapter — account checks', () => {
  it('reports a subscription as debitable only while ACTIVE, and throws when the lookup fails', async () => {
    const { adapter, requests } = fakeCashfree({
      'GET /subscriptions/sub_live': () => ({ status: 200, body: { subscription_id: 'sub_live', subscription_status: 'ACTIVE' } }),
      'GET /subscriptions/sub_paused': () => ({ status: 200, body: { subscription_status: 'ON_HOLD' } }),
      'GET /subscriptions/sub_broken': () => ({ status: 500, body: { message: 'internal' } }),
    });
    expect(await adapter.mandateStatus('sub_live')).toBe('ACTIVE');
    expect(await adapter.mandateStatus('sub_paused')).toBe('INACTIVE');
    expect(await adapter.mandateStatus('sub_unknown')).toBe('NOT_FOUND');
    await expect(adapter.mandateStatus('sub_broken')).rejects.toThrow(/Cashfree lookup failed: HTTP 500/);
    expect(requests[0]!.headers['x-client-id']).toBe('CF_APP_1');
  });

  it('checks credentials with a lookup that must 404, and tells rejection apart from an outage', async () => {
    expect(await fakeCashfree({}).adapter.checkCredentials()).toEqual({ ok: true });
    const rejected = await fakeCashfree({ 'GET /orders/.*': () => ({ status: 401, body: { message: 'authentication Failed' } }) }).adapter.checkCredentials();
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    const down = await fakeCashfree({ 'GET /orders/.*': () => 'NETWORK' }).adapter.checkCredentials();
    expect(down).toMatchObject({ ok: false, rejected: false, reason: expect.stringMatching(/Couldn't reach Cashfree/) });
  });
});
