import { randomUUID } from 'node:crypto';
import { requestJson, TransportError, type FetchFn, type HttpResponse } from '../http.js';
import type {
  CollectRequest,
  ComplaintResult,
  CredentialCheck,
  MandateLookup,
  SettlementItem,
  ComplaintStatusResult,
  ExecuteMandateRequest,
  NoticeResult,
  PreDebitNoticeRequest,
  PspAdapter,
  PspCapabilities,
  PspMode,
  PspResult,
  TransactionInquiry,
  TxnContext,
  WebhookVerification,
} from '../types.js';
import {
  customerActionFor,
  customerIdFor,
  mapReconItem,
  type CfReconItem,
  orderPayMethod,
  type CfOrderPay,
  idempotencyKey,
  inquiryFromExecution,
  inquiryFromOrder,
  latestPayment,
  mapExecution,
  mapOrderPayment,
  mapRequestError,
  toRupees,
  type CfError,
  type CfExecution,
  type CfOrderPayment,
  type CfRefund,
} from './mapping.js';
import { verifyCashfreeWebhook } from './webhook.js';

export const CASHFREE_API_VERSION = '2026-01-01';
const BASE_URLS = { sandbox: 'https://sandbox.cashfree.com/pg', production: 'https://api.cashfree.com/pg' } as const;
const HOUR = 3_600_000;

export interface CashfreeConfig {
  /** PSP id: 'cashfree' for a shared adapter, the connection id for a merchant's own account. */
  id?: string;
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'production';
  timeoutMs?: number;
  fetch?: FetchFn;
  /** Device headers Cashfree documents for UPI collect via Order Pay. */
  collectClientHeaders?: Record<string, string>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_COLLECT_HEADERS = {
  'x-client-device': 'mobile',
  'x-client-os': 'others',
  'x-client-rendering-type': 'native',
  'x-client-browser': 'others',
};

/**
 * Cashfree Payments adapter (API v2026-01-01).
 *  - UPI AutoPay via the *controlled* flow: we send the pre-debit notice, then execute at the
 *    slot Engine A chose. Mandate = Cashfree subscription_id; base payment = our debit id.
 *  - One-off UPI collect via Orders + Order Pay.
 *  - Status/inquiry via order payments + refunds (auto-refunds reveal debited-but-failed).
 * Secrets never leave the request headers: nothing here logs them.
 */
export class CashfreeAdapter implements PspAdapter {
  readonly id: string;
  readonly mode: PspMode;
  readonly capabilities: PspCapabilities = {
    minNoticeMs: 25 * HOUR, // Cashfree: 25 h between a successful notification and execution
    maxNoticeLeadMs: 6 * 24 * HOUR, // schedule date must be T+1..T+7; keep a day of margin
    udirComplaints: false, // no merchant-raised UDIR API; customers raise from their UPI app
    portableMandates: false, // a Cashfree subscription is executed through Cashfree only
    collectRequires: ['customerPhone'],
    channels: ['UPI_COLLECT', 'UPI_INTENT', 'UPI_QR', 'NETBANKING', 'CARD'],
    autopay: true, // controlled notify → execute keeps timing with Engine A
  };
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly cfg: CashfreeConfig) {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('Cashfree adapter needs a client id and secret');
    this.id = cfg.id ?? 'cashfree';
    this.mode = cfg.env === 'production' ? 'LIVE' : 'SANDBOX';
    this.baseUrl = BASE_URLS[cfg.env];
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.fetchFn = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.log = cfg.log ?? ((msg, meta) => console.warn(`[cashfree] ${msg}`, meta ?? ''));
  }

  async sendPreDebitNotice(req: PreDebitNoticeRequest): Promise<NoticeResult> {
    const notificationId = `${req.noticeRef}-n-${req.executionDate}`;
    try {
      const res = await this.post(
        '/subscriptions/pay/controlled/notify-mandate',
        {
          subscription_id: req.mandateRef,
          payment_id: req.noticeRef,
          notification_id: notificationId,
          payment_amount: toRupees(req.amountPaise),
          payment_schedule_date: `${req.executionDate}T00:00:00+05:30`,
          payment_remarks: 'Upcoming AutoPay debit',
        },
        idempotencyKey('notify', notificationId),
      );
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, reason: this.describe(res) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async executeMandate(req: ExecuteMandateRequest): Promise<PspResult> {
    return this.debitCall(() =>
      this.post('/subscriptions/pay/controlled/execute-mandate', { payment_id: req.noticeRef, execution_id: req.txnRef }, idempotencyKey('execute', req.txnRef)),
      (res) => mapExecution(res.json as CfExecution),
    );
  }

  async collect(req: CollectRequest): Promise<PspResult> {
    if (!req.customerPhone) {
      this.log('collect rejected locally: customer phone is required by Cashfree', { txnRef: req.txnRef });
      return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
    }
    if (req.channel === 'UPI_COLLECT' && !req.payerVpa) return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
    let sessionId: string | undefined;
    return this.debitCall(
      async () => {
        const order = await this.post(
          '/orders',
          {
            order_id: req.txnRef,
            order_amount: toRupees(req.amountPaise),
            order_currency: 'INR',
            customer_details: { customer_id: customerIdFor(req.payerVpa ?? req.customerPhone ?? req.txnRef), customer_phone: req.customerPhone },
          },
          idempotencyKey('order', req.txnRef),
        );
        sessionId = (order.json as { payment_session_id?: string } | null)?.payment_session_id;
        if (order.status === 409 || (order.status >= 400 && !sessionId && /already exists/i.test(String((order.json as CfError | null)?.message ?? '')))) {
          // Order created by an earlier attempt with this txnRef: reuse it.
          const existing = await this.get(`/orders/${encodeURIComponent(req.txnRef)}`);
          sessionId = (existing.json as { payment_session_id?: string } | null)?.payment_session_id;
        } else if (order.status < 200 || order.status >= 300) {
          return order;
        }
        if (!sessionId) return { status: 502, json: { message: 'order has no payment_session_id' } };
        const method = orderPayMethod(req);
        // Cards, and netbanking without a chosen bank, go through Cashfree's own checkout (its JS
        // SDK, opened with the session id): card details never pass through us.
        if (!method) return { status: 200, json: null };
        return this.post(
          '/orders/sessions',
          { payment_session_id: sessionId, payment_method: method },
          idempotencyKey(`pay:${req.channel}`, req.txnRef),
          { ...DEFAULT_COLLECT_HEADERS, ...this.cfg.collectClientHeaders },
        );
      },
      // The customer must act (approve, open the app, scan, log in to the bank): the outcome comes later via status.
      (res) => {
        const action = customerActionFor(req, res.json as CfOrderPay | null, { sessionId: sessionId!, environment: this.cfg.env });
        return action ? { kind: 'PENDING', action } : { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
      },
    );
  }

  async status(txnRef: string, ctx: TxnContext): Promise<PspResult> {
    if (ctx.kind === 'MANDATE') {
      const e = await this.fetchExecution(txnRef, ctx.noticeRef);
      return e ? mapExecution(e) : { kind: 'NOT_FOUND' };
    }
    const payments = await this.fetchOrderPayments(txnRef);
    return payments ? mapOrderPayment(latestPayment(payments)) : { kind: 'NOT_FOUND' };
  }

  async inquire(txnRef: string, ctx: TxnContext): Promise<TransactionInquiry> {
    if (ctx.kind === 'MANDATE') return inquiryFromExecution(await this.fetchExecution(txnRef, ctx.noticeRef));
    const payments = await this.fetchOrderPayments(txnRef);
    if (!payments) return { found: false };
    const refunds = await this.fetchOrderRefunds(txnRef);
    return inquiryFromOrder(payments, refunds);
  }

  async raiseComplaint(): Promise<ComplaintResult> {
    return { ok: false, reason: 'Cashfree does not offer merchant-raised UDIR complaints', retryable: false };
  }

  async complaintStatus(): Promise<ComplaintStatusResult> {
    return { ok: false, reason: 'Cashfree does not offer merchant-raised UDIR complaints' };
  }

  /** Settlement reconciliation lines processed in [from, to), all pages. */
  async settlements(range: { from: Date; to: Date }): Promise<SettlementItem[]> {
    const items: SettlementItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const res = await this.post(
        '/settlement/recon',
        {
          pagination: { limit: 1000, cursor },
          filters: { start_date_processed_on: range.from.toISOString(), end_date_processed_on: range.to.toISOString() },
        },
        idempotencyKey('recon', `${range.from.toISOString()}:${cursor ?? 'first'}`),
      );
      this.assertOk(res);
      const body = res.json as { cursor?: string | null; data?: CfReconItem[] } | null;
      for (const raw of body?.data ?? []) items.push(mapReconItem(raw));
      cursor = body?.cursor ?? null;
      if (!cursor || (body?.data ?? []).length === 0) break;
    }
    return items.filter((i) => !i.settledAt || (i.settledAt >= range.from && i.settledAt < range.to));
  }

  /** A subscription (our mandate) is debitable only while ACTIVE. Lookup failures throw. */
  async mandateStatus(mandateRef: string): Promise<MandateLookup> {
    const res = await this.get(`/subscriptions/${encodeURIComponent(mandateRef)}`);
    if (res.status === 404) return 'NOT_FOUND';
    this.assertOk(res);
    return (res.json as { subscription_status?: string } | null)?.subscription_status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  }

  /** An authenticated lookup of an order that can't exist: 404 means the keys work. */
  async checkCredentials(): Promise<CredentialCheck> {
    let res: HttpResponse;
    try {
      res = await this.get(`/orders/mf-credential-check-${randomUUID()}`);
    } catch (e) {
      return { ok: false, rejected: false, reason: `Couldn't reach Cashfree: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (res.status === 404) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true, reason: 'Cashfree rejected these credentials (check the keys and the environment)' };
    return { ok: false, rejected: false, reason: `Unexpected response from Cashfree: ${this.describe(res)}` };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, now: Date): WebhookVerification {
    return verifyCashfreeWebhook(this.cfg.clientSecret, rawBody, headers, now);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  /** Run a debit/collect request; transport failures become TIMEOUT/PSP_ERROR, never a guess. */
  private async debitCall(call: () => Promise<HttpResponse>, onOk: (res: HttpResponse) => PspResult): Promise<PspResult> {
    let res: HttpResponse;
    try {
      res = await call();
    } catch (e) {
      if (e instanceof TransportError) return { kind: 'TECHNICAL_DECLINE', code: e.kind === 'TIMEOUT' ? 'TIMEOUT' : 'PSP_ERROR' };
      throw e;
    }
    if (res.status >= 200 && res.status < 300) return onOk(res);
    if (res.status === 401 || res.status === 403) this.log('Cashfree rejected the credentials — check CASHFREE_CLIENT_ID/SECRET and environment');
    return mapRequestError(res.status, res.json as CfError | null);
  }

  private async fetchExecution(executionId: string, paymentId: string): Promise<CfExecution | null> {
    const res = await this.get(`/subscriptions/payments/${encodeURIComponent(paymentId)}/controlled/executions/${encodeURIComponent(executionId)}`);
    if (res.status === 404) return null;
    this.assertOk(res);
    return res.json as CfExecution;
  }

  private async fetchOrderPayments(orderId: string): Promise<CfOrderPayment[] | null> {
    const res = await this.get(`/orders/${encodeURIComponent(orderId)}/payments`);
    if (res.status === 404) return null;
    this.assertOk(res);
    const list = Array.isArray(res.json) ? (res.json as CfOrderPayment[]) : [];
    return list.length ? list : null;
  }

  private async fetchOrderRefunds(orderId: string): Promise<CfRefund[]> {
    const res = await this.get(`/orders/${encodeURIComponent(orderId)}/refunds`);
    if (res.status === 404) return [];
    this.assertOk(res);
    return Array.isArray(res.json) ? (res.json as CfRefund[]) : [];
  }

  /** Lookups throw on errors so callers treat them as "couldn't check" rather than as an answer. */
  private assertOk(res: HttpResponse): void {
    if (res.status < 200 || res.status >= 300) throw new Error(`Cashfree lookup failed: ${this.describe(res)}`);
  }

  private describe(res: HttpResponse): string {
    const b = res.json as CfError | null;
    return `HTTP ${res.status}${b?.code ? ` ${b.code}` : ''}${b?.message ? `: ${b.message}` : ''}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-version': CASHFREE_API_VERSION,
      'x-client-id': this.cfg.clientId,
      'x-client-secret': this.cfg.clientSecret,
      'x-request-id': randomUUID(),
      ...extra,
    };
  }

  private post(path: string, body: unknown, idemKey: string, extra: Record<string, string> = {}) {
    return requestJson(this.fetchFn, {
      method: 'POST',
      url: `${this.baseUrl}${path}`,
      headers: this.headers({ 'x-idempotency-key': idemKey, ...extra }),
      body,
      timeoutMs: this.timeoutMs,
    });
  }

  private get(path: string) {
    return requestJson(this.fetchFn, { method: 'GET', url: `${this.baseUrl}${path}`, headers: this.headers(), timeoutMs: this.timeoutMs });
  }
}
