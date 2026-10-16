/**
 * Merchantflo Node SDK — a typed client for the Merchantflo REST API. No runtime dependencies;
 * needs Node 18+ (global fetch).
 *
 *   import { Merchantflo } from '@merchantflo/node';
 *   const mf = new Merchantflo({ apiKey: process.env.MERCHANTFLO_API_KEY!, baseUrl: 'https://…' });
 *   const session = await mf.checkout.sessions.create({ amountPaise: 249900, orderId: 'ORD-1' });
 */
export { verifyWebhook, WebhookVerificationError, type VerifyWebhookInput, type WebhookEvent, type WebhookEventType, type WebhookHeaders } from './webhooks.js';

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
  /** Who executes new debits on this mandate under your current pilot stage. */
  executedBy: Executor;
}

/** Who executes a debit: Merchantflo, or your own billing system (during a pilot). */
export type Executor = 'MERCHANTFLO' | 'MERCHANT';

/** A debit Merchantflo executes. */
export interface Debit {
  /** Merchantflo sends the notice and executes this debit: do not execute it yourself. */
  executedBy: 'MERCHANTFLO';
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

/** A debit your own system executes during a pilot, with Merchantflo's plan for it. */
export interface ShadowDebit {
  object: 'shadow_debit';
  id: string;
  /** Your system executes it, as before the pilot. Merchantflo never will. */
  executedBy: 'MERCHANT';
  mandateId: string | null;
  mandateRef: string;
  orderId: string | null;
  amountPaise: number;
  source: 'MIRRORED' | 'REPORTED';
  rolloutStage: RolloutStage | null;
  requestedAt: string;
  requestedInPeak: boolean;
  dueDate: string | null;
  /** When Merchantflo would have executed it. */
  plannedAt: string;
  plannedNoticeDate: string;
  wouldRefuse: 'MANDATE_INACTIVE' | 'AMOUNT_EXCEEDS_MANDATE' | 'AFA_REQUIRED' | null;
  misroutedDebitId: string | null;
  /** What you reported with `pilot.reportExecutions`; null until then. */
  outcome: {
    status: 'SUCCEEDED' | 'FAILED';
    executedAt: string;
    failureKind: FailureKind | null;
    failureCode: string | null;
    pspTxnId: string | null;
    attempts: number | null;
    reportedAt: string | null;
  } | null;
  createdAt: string;
}

export type RolloutStage = 'SHADOW' | 'CANARY' | 'FULL';
export type FailureKind = 'TECHNICAL' | 'BUSINESS' | 'UNKNOWN';

export interface Pilot {
  stage: RolloutStage;
  /** Share of mandates Merchantflo executes while CANARY; null otherwise. */
  canaryPercent: number | null;
  since: string | null;
}

export interface Period {
  label: string;
  month: string | null;
  from: string;
  to: string;
}

interface CriterionBase {
  label: string;
  target: string;
  status: 'PASS' | 'FAIL' | 'PENDING' | 'NO_DATA';
  /** Whether moving to FULL requires it (uplift is reported, not gated). */
  gated: boolean;
  methodNote: string;
}
type Arm = { n: number; succeeded: number; rate: number | null };

export type PilotCriterion = CriterionBase &
  (
    | { key: 'doubleDebits'; details: { open: number; confirmed: number; dismissed: number } }
    | { key: 'restrictedWindowExecutions'; details: { count: number } }
    | {
        key: 'autopayUplift';
        /** Rates and the difference with its 95% interval are fractions (0.05 = 5 points). */
        details: { canary: Arm; control: Arm; difference: number | null; low: number | null; high: number | null; recoveryUpliftPp: number | null };
      }
    | { key: 'webhooksOnTime'; details: { judged: number; onTime: number; late: number; failed: number; share: number | null } }
    | {
        key: 'statementReconciles';
        details: { payments: number; reconciled: number; awaiting: number; overdue: number; mismatched: number; valueEvents: number; unverifiable: number };
      }
  );

export interface PilotScorecard {
  period: Period;
  criteria: PilotCriterion[];
  /** Every gated criterion passes. */
  passed: boolean;
}

export interface ShadowReport {
  period: Period;
  observed: { count: number; amountPaise: number; succeeded: number; successRate: number | null };
  classes: Array<{
    key: 'PEAK_RESCUE' | 'RETRY_RECOVERABLE' | 'PEAK_RISK' | 'WOULD_REFUSE' | 'BUSINESS_DECLINE' | 'UNCLASSIFIED_FAILURE' | 'NO_CHANGE';
    label: string;
    value: 'CERTAIN' | 'POTENTIAL' | 'NONE';
    methodNote: string;
    count: number;
    amountPaise: number;
  }>;
  /** Value Merchantflo would certainly have protected. */
  certainPaise: number;
  /** At most this much more: an upper bound, never added to the certain value. */
  potentialPaise: number;
  estimate: { recoveryRate: number; sample: number; amountPaise: number } | null;
  estimateNote: string;
  projectedSuccessRate: { atLeast: number | null; atMost: number | null };
  bySource: { MIRRORED: number; REPORTED: number };
  awaitingOutcome: number;
  outcomeCoverage: number | null;
  coverageNote: string;
}

/** What your own system did with a debit (or, for history, any past AutoPay execution). */
export interface ExecutionReport {
  /** The key the debit was requested with, or any unique id for history. */
  idempotencyKey: string;
  /** Required for history (a key Merchantflo never saw). */
  mandateRef?: string;
  amountPaise?: number;
  orderId?: string;
  requestedAt?: string;
  dueDate?: string;
  executedAt: string;
  outcome: 'SUCCEEDED' | 'FAILED';
  /** Only TECHNICAL failures count as recoverable. Default UNKNOWN. */
  failureKind?: FailureKind;
  failureCode?: string;
  pspTxnId?: string;
  attempts?: number;
}

export interface ExecutionReportResult {
  summary: { recorded: number; updated: number; unchanged: number; created: number; misrouted: number; conflicts: number; invalid: number };
  results: Array<{
    index: number;
    idempotencyKey: string | null;
    status: 'RECORDED' | 'UPDATED' | 'UNCHANGED' | 'CREATED' | 'MISROUTED' | 'CONFLICT' | 'INVALID';
    shadowDebitId?: string;
    debitId?: string;
    /** A misrouted debit Merchantflo had not started was handed back to you (never executed by us). */
    handedBack?: boolean;
    debitState?: string;
    error?: string;
  }>;
}

/** A period: a billing month (`YYYY-MM`, IST), or `from`/`to` instants. Default: this month. */
export type PeriodParams = { month?: string; from?: string; to?: string };

export interface WebhookDelivery {
  /** Also the webhook body's `id`: the same across retries and redeliveries. */
  id: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  failedAt: string | null;
  nextAttemptAt: string | null;
  data: Record<string, unknown>;
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
    /**
     * Merchantflo sends the pre-debit notice and executes in a compliant off-peak slot. During a
     * pilot, check `executedBy`: a `ShadowDebit` (`MERCHANT`) is yours to execute as before.
     */
    create: (mandateId: string, params: CreateDebitParams, o?: RequestOptions) => this.request<Debit | ShadowDebit>('POST', `/v1/mandates/${enc(mandateId)}/debits`, params, o),
    retrieve: (id: string) => this.request<Debit>('GET', `/v1/debits/${enc(id)}`),
    list: (q: { state?: Debit['state']; limit?: number } = {}) => this.request<List<Debit>>('GET', '/v1/debits', undefined, undefined, q),
  };

  readonly pilot = {
    /** Your rollout stage: who executes your AutoPay debits. */
    get: () => this.request<Pilot>('GET', '/v1/pilot'),
    /** The five pass criteria for a period. */
    scorecard: (q: PeriodParams = {}) => this.request<PilotScorecard>('GET', '/v1/pilot/scorecard', undefined, undefined, q),
    /** What Merchantflo would have saved on the debits your system executed. */
    report: (q: PeriodParams = {}) => this.request<ShadowReport>('GET', '/v1/pilot/report', undefined, undefined, q),
    /** Report what your system did (up to 5,000 per call); safe to repeat — a later report replaces an earlier one. */
    reportExecutions: (executions: ExecutionReport[]) => this.request<ExecutionReportResult>('POST', '/v1/pilot/executions', { executions }),
  };

  readonly shadowDebits = {
    retrieve: (id: string) => this.request<ShadowDebit>('GET', `/v1/shadow-debits/${enc(id)}`),
    /** Newest first; `reported: false` lists the ones still waiting for your outcome report. */
    list: (q: { reported?: boolean; before?: string; limit?: number } = {}) =>
      this.request<List<ShadowDebit> & { nextBefore: string | null }>('GET', '/v1/shadow-debits', undefined, undefined, {
        ...(q.reported === undefined ? {} : { reported: String(q.reported) }),
        before: q.before,
        limit: q.limit,
      }),
  };

  readonly webhookDeliveries = {
    /** Newest first; pass the previous page's `nextBefore` as `before` for older ones. */
    list: (q: { status?: WebhookDelivery['status']; event?: string; before?: string; limit?: number } = {}) =>
      this.request<List<WebhookDelivery> & { nextBefore: string | null }>('GET', '/v1/webhook-deliveries', undefined, undefined, q),
    /** Send a delivered or failed webhook again (same id, signed with your current secret). */
    redeliver: (id: string) => this.request<WebhookDelivery>('POST', `/v1/webhook-deliveries/${enc(id)}/redeliver`),
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
