import { bigint, boolean, index, integer, jsonb, pgTable, pgView, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Capture, ComplaintReason, ComplaintStatus, CustomerDebit, PspMode, ReversalStatus } from '../psp/types.js';
import type { CaseReason, CaseResolution, CaseStatus, EventType, SubjectType, VerificationStatus } from '../tracking/types.js';
import type { MerchantCategory } from '../rules/mdr.js';
import type { MethodCosts, SteeringConfig } from '../rules/steering.js';

const money = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

/** TEST merchants use sandbox/mock PSPs only; LIVE merchants only their own production PSP accounts. */
export type MerchantMode = 'TEST' | 'LIVE';

export const merchants = pgTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mode: text('mode').$type<MerchantMode>().notNull().default('TEST'),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret').notNull(),
  category: text('category').$type<MerchantCategory>().notNull(),
  smallMerchant: boolean('small_merchant').notNull().default(false),
  methodCosts: jsonb('method_costs').$type<MethodCosts>().notNull(),
  steering: jsonb('steering').$type<SteeringConfig>().notNull(),
  createdAt: createdAt(),
});

/** Merchant API keys, stored as SHA-256 hashes. A merchant may hold several (rotation). */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    /** First characters of the key (e.g. "sk_live_Ab3d"), safe to display. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    label: text('label'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('api_keys_merchant').on(t.merchantId)],
);

export type PspProvider = 'cashfree' | 'mock';
export type PspEnvironment = 'sandbox' | 'production';
export type ConnectionStatus = 'ACTIVE' | 'DISABLED';

/**
 * A merchant's own account at a payment provider (ADR 0002). Its id is the PSP id used in
 * routing, mandates, payments and tracking. Credentials are sealed with SecretBox.
 */
export const pspConnections = pgTable(
  'psp_connections',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    provider: text('provider').$type<PspProvider>().notNull(),
    label: text('label').notNull(),
    environment: text('environment').$type<PspEnvironment>().notNull(),
    status: text('status').$type<ConnectionStatus>().notNull().default('ACTIVE'),
    /** Routing preference among the merchant's connections; lower goes first. */
    priority: integer('priority').notNull().default(100),
    credentialsSealed: text('credentials_sealed'),
    /** Non-secret hint for the UI, e.g. the client id's last characters. */
    publicHint: text('public_hint'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('connections_merchant').on(t.merchantId, t.status)],
);

export const vendors = pgTable(
  'vendors',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    category: text('category').$type<MerchantCategory>().notNull(),
    smallMerchant: boolean('small_merchant').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vendors_merchant_external').on(t.merchantId, t.externalId)],
);

export type MandateStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED';

export const mandates = pgTable(
  'mandates',
  {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  /** UMN / mandate reference at the PSP. */
  mandateRef: text('mandate_ref').notNull(),
  customerVpa: text('customer_vpa').notNull(),
  maxAmountPaise: money('max_amount_paise').notNull(),
  /** PSPs that can execute this mandate (several when MIC-portable), in priority order. */
  eligiblePsps: jsonb('eligible_psps').$type<string[]>().notNull(),
  /** Per-mandate no-AFA limit for eligible categories; null = the regulatory default. */
  noAfaLimitPaise: money('no_afa_limit_paise'),
  status: text('status').$type<MandateStatus>().notNull().default('ACTIVE'),
  createdAt: createdAt(),
  },
  // One record per mandate per merchant: two records for one UMN could each be debited.
  (t) => [uniqueIndex('mandates_merchant_ref').on(t.merchantId, t.mandateRef)],
);

export type DebitState = 'SCHEDULED' | 'EXECUTING' | 'PENDING_CONFIRMATION' | 'SUCCEEDED' | 'FAILED';

export const debits = pgTable(
  'debits',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    mandateId: text('mandate_id').notNull().references(() => mandates.id),
    amountPaise: money('amount_paise').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Merchant's own reference (invoice/order), optional. */
    orderId: text('order_id'),
    state: text('state').$type<DebitState>().notNull(),
    requestedAt: ts('requested_at').notNull(),
    requestedInPeak: boolean('requested_in_peak').notNull(),
    dueDate: text('due_date'),
    scheduledAt: ts('scheduled_at').notNull(),
    /**
     * IST date stated in the pre-debit notice; execution must happen on this date. Null while the
     * notice is deferred (provider only accepts notices a few days ahead) — scheduled_at is then
     * when the notice will be sent.
     */
    noticeDate: text('notice_date'),
    noticeSentAt: ts('notice_sent_at'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lastTxnRef: text('last_txn_ref'),
    lastPspId: text('last_psp_id'),
    lastErrorCode: text('last_error_code'),
    pspTxnId: text('psp_txn_id'),
    executingSince: ts('executing_since'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('debits_merchant_idem').on(t.merchantId, t.idempotencyKey),
    index('debits_due').on(t.state, t.scheduledAt),
    index('debits_merchant_order').on(t.merchantId, t.orderId),
  ],
);

export type PaymentState = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    amountPaise: money('amount_paise').notNull(),
    payerVpa: text('payer_vpa').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Merchant's own order reference, optional. */
    orderId: text('order_id'),
    quoteId: text('quote_id'),
    state: text('state').$type<PaymentState>().notNull(),
    pspId: text('psp_id'),
    pspTxnId: text('psp_txn_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_merchant_idem').on(t.merchantId, t.idempotencyKey),
    index('payments_merchant_order').on(t.merchantId, t.orderId),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull(),
    debitId: text('debit_id'),
    paymentId: text('payment_id'),
    pspId: text('psp_id').notNull(),
    txnRef: text('txn_ref').notNull(),
    /** 'execute' | 'collect' | 'status' */
    op: text('op').notNull(),
    outcome: text('outcome').notNull(),
    code: text('code'),
    latencyMs: integer('latency_ms').notNull(),
    /** Order within one routing call (attempts from a single call share created_at). */
    seq: integer('seq').notNull().default(0),
    /** Attempt made only to probe this PSP's health; never earns routing-recovery credit. */
    probe: boolean('probe').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('attempts_debit').on(t.debitId),
    index('attempts_payment').on(t.paymentId),
    index('attempts_merchant_time').on(t.merchantId, t.createdAt),
  ],
);

export const checkoutQuotes = pgTable('checkout_quotes', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  amountPaise: money('amount_paise').notNull(),
  ruleSetId: text('rule_set_id').notNull(),
  quote: jsonb('quote').notNull(),
  acceptedMethod: text('accepted_method'),
  acceptedAt: ts('accepted_at'),
  /** When the merchant reported the payment for this quote as paid (savings are booked then). */
  paidAt: ts('paid_at'),
  /** The merchant's / PSP's reference for that payment. */
  paymentReference: text('payment_reference'),
  createdAt: createdAt(),
});

export type SavingsType =
  | 'PEAK_DEFERRAL_RESCUED'
  | 'TD_RECOVERED'
  | 'MDR_STEERING_OFFERED'
  | 'MDR_STEERING_ACCEPTED';

export const savingsEvents = pgTable(
  'savings_events',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    type: text('type').$type<SavingsType>().notNull(),
    amountPaise: money('amount_paise').notNull(),
    refId: text('ref_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('savings_merchant_time').on(t.merchantId, t.createdAt),
    uniqueIndex('savings_type_ref').on(t.type, t.refId),
  ],
);

export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull(),
    deliveredAt: ts('delivered_at'),
    deadAt: ts('dead_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_due').on(t.deliveredAt, t.nextAttemptAt)],
);

// ─── Phase 3: tracking, cases, UDIR, audit, dashboard auth ────────────────────────────────

/**
 * Money-movement facts and verification lifecycle for one payment (collect or AutoPay debit).
 * Lives beside the Phase 1-2 tables so their state machines stay untouched.
 */
export const paymentTracking = pgTable(
  'payment_tracking',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    subjectType: text('subject_type').$type<SubjectType>().notNull(),
    subjectId: text('subject_id').notNull(),
    pspId: text('psp_id'),
    txnRef: text('txn_ref'),
    upiRrn: text('upi_rrn'),
    npciTxnId: text('npci_txn_id'),
    customerDebit: text('customer_debit').$type<CustomerDebit>().notNull().default('UNKNOWN'),
    capture: text('capture').$type<Capture>().notNull().default('UNKNOWN'),
    reversalStatus: text('reversal_status').$type<ReversalStatus>().notNull().default('NONE'),
    reversalInitiatedAt: ts('reversal_initiated_at'),
    reversalCompletedAt: ts('reversal_completed_at'),
    verificationStatus: text('verification_status').$type<VerificationStatus>().notNull(),
    verificationStartedAt: ts('verification_started_at'),
    nextCheckAt: ts('next_check_at'),
    checkCount: integer('check_count').notNull().default(0),
    lastCheckedAt: ts('last_checked_at'),
    lastManualCheckAt: ts('last_manual_check_at'),
    leaseUntil: ts('lease_until'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tracking_subject').on(t.subjectType, t.subjectId),
    index('tracking_merchant_rrn').on(t.merchantId, t.upiRrn),
    index('tracking_due').on(t.verificationStatus, t.nextCheckAt),
  ],
);

/** A payment issue that may need merchant attention (a "dispute" on the Dispute Desk). */
export const paymentCases = pgTable(
  'payment_cases',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    subjectType: text('subject_type').$type<SubjectType>().notNull(),
    subjectId: text('subject_id').notNull(),
    trackingId: text('tracking_id').notNull().references(() => paymentTracking.id),
    reason: text('reason').$type<CaseReason>().notNull(),
    status: text('status').$type<CaseStatus>().notNull(),
    resolution: text('resolution').$type<CaseResolution>(),
    closedByMerchant: boolean('closed_by_merchant').notNull().default(false),
    openedAt: ts('opened_at').notNull(),
    resolvedAt: ts('resolved_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('cases_merchant_status').on(t.merchantId, t.status, t.openedAt),
    index('cases_subject').on(t.subjectType, t.subjectId),
  ],
);

export const udirComplaints = pgTable(
  'udir_complaints',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id').notNull().references(() => paymentCases.id),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    pspId: text('psp_id').notNull(),
    /** MOCK complaints were never sent to a PSP; SANDBOX ones went to a PSP's test environment. */
    mode: text('mode').$type<PspMode>().notNull(),
    pspComplaintRef: text('psp_complaint_ref').notNull(),
    reasonCode: text('reason_code').$type<ComplaintReason>().notNull(),
    status: text('status').$type<ComplaintStatus>().notNull(),
    raisedByUserId: text('raised_by_user_id'),
    raisedAt: ts('raised_at').notNull(),
    lastStatusAt: ts('last_status_at').notNull(),
  },
  (t) => [index('complaints_case').on(t.caseId)],
);

export const caseNotes = pgTable(
  'case_notes',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id').notNull().references(() => paymentCases.id),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    authorUserId: text('author_user_id').notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('notes_case').on(t.caseId, t.createdAt)],
);

export type ActorType = 'SYSTEM' | 'DASHBOARD_USER' | 'API_KEY';

/** Append-only audit log; source of payment timelines and future analytics. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    subjectType: text('subject_type').$type<SubjectType>(),
    subjectId: text('subject_id'),
    caseId: text('case_id'),
    type: text('type').$type<EventType>().notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    /** Monotonic per process; orders events written within the same millisecond. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('events_subject').on(t.subjectType, t.subjectId, t.createdAt),
    index('events_merchant').on(t.merchantId, t.createdAt),
  ],
);

export type DashboardRole = 'ADMIN' | 'SUPPORT' | 'VIEWER';

export const dashboardUsers = pgTable('dashboard_users', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  /** Stored lower-cased; unique across merchants so login needs only email + password. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<DashboardRole>().notNull(),
  disabled: boolean('disabled').notNull().default(false),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  lastLoginAt: ts('last_login_at'),
  createdBy: text('created_by'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const dashboardSessions = pgTable(
  'dashboard_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => dashboardUsers.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/**
 * Read model unifying one-off collects and AutoPay debits for the dashboard.
 * Created by drizzle/0002_merchant_payments_view.sql; declared here for typed queries only.
 */
export const merchantPaymentsView = pgView('merchant_payments_v', {
  subjectType: text('subject_type').$type<SubjectType>().notNull(),
  id: text('id').notNull(),
  merchantId: text('merchant_id').notNull(),
  orderId: text('order_id'),
  amountPaise: money('amount_paise').notNull(),
  rawState: text('raw_state').notNull(),
  domainState: text('domain_state').$type<'PENDING' | 'SUCCEEDED' | 'FAILED'>().notNull(),
  pspId: text('psp_id'),
  createdAt: ts('created_at').notNull(),
  lastUpdatedAt: ts('last_updated_at').notNull(),
  pendingSince: ts('pending_since').notNull(),
  awaitingExecution: boolean('awaiting_execution').notNull(),
  scheduledAt: ts('scheduled_at'),
  trackingId: text('tracking_id'),
  upiRrn: text('upi_rrn'),
  npciTxnId: text('npci_txn_id'),
  customerDebit: text('customer_debit').$type<CustomerDebit>(),
  capture: text('capture').$type<Capture>(),
  reversalStatus: text('reversal_status').$type<ReversalStatus>(),
  reversalInitiatedAt: ts('reversal_initiated_at'),
  reversalCompletedAt: ts('reversal_completed_at'),
  verificationStatus: text('verification_status').$type<VerificationStatus>(),
}).existing();
