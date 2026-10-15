/**
 * Merchantflo Node SDK — a typed client for the Merchantflo REST API. No runtime dependencies;
 * needs Node 18+ (global fetch).
 *
 *   import { Merchantflo } from '@merchantflo/node';
 *   const mf = new Merchantflo({ apiKey: process.env.MERCHANTFLO_API_KEY!, baseUrl: 'https://…' });
 *   const session = await mf.checkout.sessions.create({ amountPaise: 249900, orderId: 'ORD-1' });
 */
export { verifyWebhook, WebhookVerificationError, type VerifyWebhookInput, type WebhookEvent, type WebhookHeaders } from './webhooks.js';

export const VERSION = '0.1.0';

// ─── Objects ──────────────────────────────────────────────────────────────────────────────

export type PaymentMethod = 'UPI' | 'NETBANKING' | 'RUPAY_DEBIT' | 'CARD';
export type PaymentChannel = 'UPI_COLLECT' | 'UPI_INTENT' | 'UPI_QR' | 'NETBANKING' | 'CARD';
export type CustomerStatus = 'processing' | 'success' | 'failed' | 'verification_in_progress' | 'refund_processing' | 'refunded';
export type MerchantStatus =
  | 'SCHEDULED' | 'PROCESSING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'DEBITED_NOT_CAPTURED'
  | 'CAPTURED_AFTER_FAILURE' | 'REVERSAL_IN_PROGRESS' | 'REVERSED' | 'NEEDS_INVESTIGATION';

/** What the customer must do to pay; present while a payment is pending. */
export type CustomerAction =
  | { type: 'UPI_COLLECT'; vpa: string }
  | { type: 'UPI_INTENT'; url: string; appUrls: Record<string, string> }
  | { type: 'UPI_QR'; qrData?: string | undefined; qrImage?: string | undefined }
  | { type: 'REDIRECT'; url: string }
  | { type: 'PSP_CHECKOUT'; provider: string; environment: 'sandbox' | 'production'; params: Record<string, string> };

export interface Payment {
  id: string;
  orderId: string | null;
  amountPaise: number;
  channel: PaymentChannel;
  payerVpa: string | null;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  customerAction: CustomerAction | null;
  pspId: string | null;
  pspTxnId: string | null;
  lastErrorCode: string | null;
  quoteId: string | null;
  createdAt: string;
  /** Where the money is, as Merchantflo's poller last saw it. */
  merchantStatus: MerchantStatus;
  merchantStatusLabel: string;
  customerDebit: 'DEBITED' | 'NOT_DEBITED' | 'UNKNOWN';
  capture: 'CAPTURED' | 'NOT_CAPTURED' | 'UNKNOWN';
  reversalStatus: 'NONE' | 'INITIATED' | 'COMPLETED' | 'UNKNOWN';
  upiRrn: string | null;
  /** Only on creation: lets your checkout page read this payment's customer-safe status. */
  customerStatusToken?: string | undefined;
}

export interface CheckoutSession {
  id: string;
  amountPaise: number;
  orderId: string | null;
  status: 'OPEN' | 'PAID' | 'EXPIRED';
  expiresAt: string;
  returnUrl: string | null;
  methods: {
    method: PaymentMethod;
    payablePaise: number;
    discountPaise: number;
    recommended: boolean;
    upiFlows?: ('INTENT' | 'QR' | 'COLLECT')[] | undefined;
  }[];
  payment: {
    id: string;
    method: PaymentMethod;
    channel: PaymentChannel;
    amountPaise: number;
    status: CustomerStatus;
    message: string;
    action: CustomerAction | null;
  } | null;
  /** Only on creation: pass it to checkout.js. */
  clientToken?: string | undefined;
}

export interface Mandate {
  id: string;
  merchantId: string;
  mandateRef: string;
  customerVpa: string;
  maxAmountPaise: number;
  eligiblePsps: string[];
  noAfaLimitPaise: number | null;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  createdAt: string;
}

export interface Debit {
  id: string;
  mandateId: string;
  orderId: string | null;
  amountPaise: number;
  state: 'SCHEDULED' | 'EXECUTING' | 'PENDING_CONFIRMATION' | 'SUCCEEDED' | 'FAILED';
  requestedAt: string;
  requestedInPeak: boolean;
  dueDate: string | null;
  scheduledAt: string;
  noticeDate: string | null;
  noticePending: boolean;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  pspTxnId: string | null;
  completedAt: string | null;
}

export interface List<T> {
  data: T[];
}

// ─── Parameters ───────────────────────────────────────────────────────────────────────────

export interface CreateCheckoutSessionParams {
  amountPaise: number;
  orderId?: string;
  customer?: { phone?: string; vpa?: string };
  returnUrl?: string;
  expiresInMinutes?: number;
}

export interface CreatePaymentParams {
  amountPaise: number;
  channel?: PaymentChannel;
  payerVpa?: string;
  netbankingBankCode?: string;
  client?: { ip?: string; userAgent?: string };
  orderId?: string;
  quoteId?: string;
  customerPhone?: string;
}

export interface CreateMandateParams {
  mandateRef: string;
  customerVpa: string;
  maxAmountPaise: number;
  eligiblePsps?: string[];
  noAfaLimitPaise?: number;
}

export interface UpdateMandateParams {
  eligiblePsps?: string[];
  maxAmountPaise?: number;
  noAfaLimitPaise?: number | null;
}

export interface CreateDebitParams {
  amountPaise: number;
  /** IST date (YYYY-MM-DD) the debit is due. */
  dueDate?: string;
  orderId?: string;
}

export interface RequestOptions {
  /** Makes a create safe to retry: the same key returns the original object. */
  idempotencyKey?: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────────────────

export class MerchantfloError extends Error {
  override readonly name = 'MerchantfloError';
  constructor(
    message: string,
    /** HTTP status (0 when no response arrived). */
    readonly status: number,
    /** Merchantflo error code, e.g. VALIDATION, NOT_FOUND, CONFLICT, UNAUTHORIZED. */
    readonly code: string,
  ) {
    super(message);
  }
}

export interface MerchantfloOptions {
  /** `sk_test_…` or `sk_live_…`. */
  apiKey: string;
  /** Your Merchantflo API origin, e.g. https://api.merchantflo.example. */
  baseUrl: string;
  /** Retries for reads and idempotent writes on network errors, 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** First retry delay (doubles each time). Default 500 ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

export class Merchantflo {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MerchantfloOptions) {
    if (!opts.apiKey) throw new Error('Merchantflo: apiKey is required');
    if (!opts.baseUrl) throw new Error('Merchantflo: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  readonly checkout = {
    sessions: {
      create: (params: CreateCheckoutSessionParams, o?: RequestOptions) => this.request<CheckoutSession>('POST', '/v1/checkout/sessions', params, o),
      retrieve: (id: string) => this.request<CheckoutSession>('GET', `/v1/checkout/sessions/${enc(id)}`),
    },
  };

  readonly payments = {
    create: (params: CreatePaymentParams, o?: RequestOptions) => this.request<Payment>('POST', '/v1/payments', params, o),
    retrieve: (id: string) => this.request<Payment>('GET', `/v1/payments/${enc(id)}`),
  };

  readonly mandates = {
    create: (params: CreateMandateParams) => this.request<Mandate>('POST', '/v1/mandates', params),
    retrieve: (id: string) => this.request<Mandate>('GET', `/v1/mandates/${enc(id)}`),
    update: (id: string, params: UpdateMandateParams) => this.request<Mandate>('PATCH', `/v1/mandates/${enc(id)}`, params),
    revoke: (id: string) => this.request<Mandate>('POST', `/v1/mandates/${enc(id)}/revoke`),
  };

  readonly debits = {
    /** Merchantflo sends the pre-debit notice and executes in a compliant off-peak slot. */
    create: (mandateId: string, params: CreateDebitParams, o?: RequestOptions) => this.request<Debit>('POST', `/v1/mandates/${enc(mandateId)}/debits`, params, o),
    retrieve: (id: string) => this.request<Debit>('GET', `/v1/debits/${enc(id)}`),
    list: (q: { state?: Debit['state']; limit?: number } = {}) => this.request<List<Debit>>('GET', '/v1/debits', undefined, undefined, q),
  };

  /** Any API call not wrapped above. */
  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, o: RequestOptions = {}, query: Query = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      accept: 'application/json',
      'user-agent': `merchantflo-node/${VERSION}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
    // Repeating a read, or a write carrying an idempotency key, can't do anything twice.
    const retryable = method === 'GET' || Boolean(o.idempotencyKey);
    const maxRetries = retryable ? (this.opts.maxRetries ?? 2) : 0;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (e) {
        if (attempt < maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw e;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await this.backoff(attempt);
        continue;
      }
      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new MerchantfloError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? 'HTTP_ERROR');
      }
      return json as T;
    }
  }

  private backoff(attempt: number): Promise<void> {
    const ms = (this.opts.retryDelayMs ?? 500) * 2 ** attempt;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
