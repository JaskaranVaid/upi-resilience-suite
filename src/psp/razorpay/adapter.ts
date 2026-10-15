import { requestJson, TransportError, type FetchFn, type HttpResponse } from '../http.js';
import type {
  CollectRequest,
  ComplaintResult,
  ComplaintStatusResult,
  CredentialCheck,
  ExecuteMandateRequest,
  NoticeResult,
  PspAdapter,
  PspCapabilities,
  PspMode,
  PspResult,
  TransactionInquiry,
  TxnContext,
  WebhookVerification,
} from '../types.js';
import {
  actionFromUpiResponse,
  inquiryFromPayment,
  latestPayment,
  mapPayment,
  mapRequestError,
  NO_EMAIL,
  type RzpError,
  type RzpOrder,
  type RzpPayment,
  type RzpRefund,
} from './mapping.js';
import { verifyRazorpayWebhook } from './webhook.js';

const BASE_URL = 'https://api.razorpay.com/v1';

export interface RazorpayConfig {
  /** PSP id: the merchant's connection id. */
  id: string;
  keyId: string;
  keySecret: string;
  /** Secret configured for webhooks in the Razorpay dashboard (separate from the key secret). */
  webhookSecret?: string;
  timeoutMs?: number;
  fetch?: FetchFn;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Razorpay adapter: one-off payments only (orders + S2S UPI collect/intent; cards and netbanking via
 * Razorpay Checkout). Razorpay runs UPI AutoPay on its own schedule, so it can't execute Engine A's
 * timing-controlled debits (capabilities.autopay = false).
 *
 * Razorpay assigns order ids, so our txnRef is the order `receipt`, and an existing order is always
 * looked up by receipt before one is created (a retried attempt never creates a second order).
 * Enable automatic capture in the Razorpay dashboard: an authorized payment that is never captured
 * is reversed by Razorpay, which we then report as a reversal.
 */
export class RazorpayAdapter implements PspAdapter {
  readonly id: string;
  readonly mode: PspMode;
  readonly capabilities: PspCapabilities = {
    minNoticeMs: 0,
    maxNoticeLeadMs: null,
    udirComplaints: false,
    portableMandates: false,
    collectRequires: ['customerPhone'],
    channels: ['UPI_COLLECT', 'UPI_INTENT', 'NETBANKING', 'CARD'],
    autopay: false,
  };
  private readonly auth: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly cfg: RazorpayConfig) {
    if (!cfg.keyId || !cfg.keySecret) throw new Error('Razorpay adapter needs a key id and secret');
    this.id = cfg.id;
    this.mode = cfg.keyId.startsWith('rzp_live_') ? 'LIVE' : 'SANDBOX';
    this.auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.fetchFn = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.log = cfg.log ?? ((msg, meta) => console.warn(`[razorpay] ${msg}`, meta ?? ''));
  }

  async sendPreDebitNotice(): Promise<NoticeResult> {
    return { ok: false, reason: 'Razorpay connections do not execute AutoPay mandates through Merchantflo' };
  }

  async executeMandate(_req: ExecuteMandateRequest): Promise<PspResult> {
    return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
  }

  async collect(req: CollectRequest): Promise<PspResult> {
    if (!req.customerPhone) return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
    if (req.channel === 'UPI_QR' || (req.channel === 'UPI_COLLECT' && !req.payerVpa)) return { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
    let order: RzpOrder | undefined;
    return this.debitCall(
      async () => {
        const found = await this.findOrder(req.txnRef);
        if (found) order = found;
        else {
          const created = await this.post('/orders', { amount: req.amountPaise, currency: 'INR', receipt: req.txnRef, notes: { merchantflo_ref: req.txnRef } });
          if (created.status < 200 || created.status >= 300) return created;
          order = created.json as RzpOrder;
        }
        // Cards and netbanking: Razorpay Checkout opens with the order (card data never reaches us).
        if (req.channel === 'CARD' || req.channel === 'NETBANKING') return { status: 200, json: null };
        const flow = req.channel === 'UPI_INTENT' ? 'intent' : 'collect';
        return this.post('/payments/create/upi', {
          amount: req.amountPaise,
          currency: 'INR',
          order_id: order.id,
          email: NO_EMAIL,
          contact: req.customerPhone,
          method: 'upi',
          upi: flow === 'collect' ? { flow, vpa: req.payerVpa, expiry_time: 10 } : { flow },
          notes: { merchantflo_ref: req.txnRef },
          ...(req.client?.ip ? { ip: req.client.ip } : {}),
          ...(req.client?.userAgent ? { user_agent: req.client.userAgent } : {}),
        });
      },
      (res) => {
        if (req.channel === 'CARD' || req.channel === 'NETBANKING') {
          const environment = this.mode === 'LIVE' ? 'production' : 'sandbox';
          return { kind: 'PENDING', action: { type: 'PSP_CHECKOUT', provider: 'razorpay', environment, params: { keyId: this.cfg.keyId, orderId: order!.id, method: req.channel.toLowerCase() } } };
        }
        const action = actionFromUpiResponse(req.channel === 'UPI_INTENT' ? 'intent' : 'collect', req.payerVpa, res.json as { next?: Array<{ action?: string; url?: string }> } | null);
        return action ? { kind: 'PENDING', action } : { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
      },
    );
  }

  async status(txnRef: string, _ctx: TxnContext): Promise<PspResult> {
    const payments = await this.orderPayments(txnRef);
    return payments ? mapPayment(latestPayment(payments)) : { kind: 'NOT_FOUND' };
  }

  async inquire(txnRef: string, _ctx: TxnContext): Promise<TransactionInquiry> {
    const payments = await this.orderPayments(txnRef);
    if (!payments) return { found: false };
    const p = latestPayment(payments);
    const refunds = p && p.status === 'refunded' && !p.captured ? await this.refunds(p.id) : [];
    return inquiryFromPayment(p, refunds);
  }

  async raiseComplaint(): Promise<ComplaintResult> {
    return { ok: false, reason: 'Razorpay does not offer merchant-raised UDIR complaints', retryable: false };
  }

  async complaintStatus(): Promise<ComplaintStatusResult> {
    return { ok: false, reason: 'Razorpay does not offer merchant-raised UDIR complaints' };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookVerification {
    if (!this.cfg.webhookSecret) return { ok: false, reason: 'no webhook secret configured for this connection' };
    return verifyRazorpayWebhook(this.cfg.webhookSecret, rawBody, headers);
  }

  async checkCredentials(): Promise<CredentialCheck> {
    let res: HttpResponse;
    try {
      res = await this.get('/orders?count=1');
    } catch (e) {
      return { ok: false, rejected: false, reason: `Couldn't reach Razorpay: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, rejected: true, reason: 'Razorpay rejected these keys (check the key id and secret)' };
    return { ok: false, rejected: false, reason: `Unexpected response from Razorpay: ${this.describe(res)}` };
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  private async debitCall(call: () => Promise<HttpResponse>, onOk: (res: HttpResponse) => PspResult): Promise<PspResult> {
    let res: HttpResponse;
    try {
      res = await call();
    } catch (e) {
      if (e instanceof TransportError) return { kind: 'TECHNICAL_DECLINE', code: e.kind === 'TIMEOUT' ? 'TIMEOUT' : 'PSP_ERROR' };
      throw e;
    }
    if (res.status >= 200 && res.status < 300) return onOk(res);
    if (res.status === 401) this.log('Razorpay rejected the keys — check the connection credentials');
    return mapRequestError(res.status, res.json as RzpError | null);
  }

  /** The order whose receipt is our txnRef. Lookup failures throw ("couldn't check", not "absent"). */
  private async findOrder(txnRef: string): Promise<RzpOrder | undefined> {
    const res = await this.get(`/orders?receipt=${encodeURIComponent(txnRef)}&count=1`);
    this.assertOk(res);
    return ((res.json as { items?: RzpOrder[] } | null)?.items ?? []).find((o) => o.receipt === txnRef);
  }

  private async orderPayments(txnRef: string): Promise<RzpPayment[] | null> {
    const order = await this.findOrder(txnRef);
    if (!order) return null;
    const res = await this.get(`/orders/${encodeURIComponent(order.id)}/payments`);
    this.assertOk(res);
    const items = (res.json as { items?: RzpPayment[] } | null)?.items ?? [];
    return items.length ? items : null;
  }

  private async refunds(paymentId: string): Promise<RzpRefund[]> {
    const res = await this.get(`/payments/${encodeURIComponent(paymentId)}/refunds`);
    this.assertOk(res);
    return (res.json as { items?: RzpRefund[] } | null)?.items ?? [];
  }

  private assertOk(res: HttpResponse): void {
    if (res.status < 200 || res.status >= 300) throw new Error(`Razorpay lookup failed: ${this.describe(res)}`);
  }

  private describe(res: HttpResponse): string {
    const e = (res.json as RzpError | null)?.error;
    return `HTTP ${res.status}${e?.code ? ` ${e.code}` : ''}${e?.description ? `: ${e.description}` : ''}`;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: this.auth };
  }

  private post(path: string, body: unknown) {
    return requestJson(this.fetchFn, { method: 'POST', url: `${BASE_URL}${path}`, headers: this.headers(), body, timeoutMs: this.timeoutMs });
  }

  private get(path: string) {
    return requestJson(this.fetchFn, { method: 'GET', url: `${BASE_URL}${path}`, headers: this.headers(), timeoutMs: this.timeoutMs });
  }
}
