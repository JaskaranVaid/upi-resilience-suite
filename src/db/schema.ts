import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { MerchantCategory } from '../rules/mdr.js';
import type { MethodCosts, SteeringConfig } from '../rules/steering.js';

const money = (name: string) => bigint(name, { mode: 'number' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const merchants = pgTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret').notNull(),
  category: text('category').$type<MerchantCategory>().notNull(),
  smallMerchant: boolean('small_merchant').notNull().default(false),
  methodCosts: jsonb('method_costs').$type<MethodCosts>().notNull(),
  steering: jsonb('steering').$type<SteeringConfig>().notNull(),
  createdAt: createdAt(),
});

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

export const mandates = pgTable('mandates', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  /** UMN / mandate reference at the PSP. */
  mandateRef: text('mandate_ref').notNull(),
  customerVpa: text('customer_vpa').notNull(),
  maxAmountPaise: money('max_amount_paise').notNull(),
  /** PSPs that can execute this mandate (several when MIC-portable), in priority order. */
  eligiblePsps: jsonb('eligible_psps').$type<string[]>().notNull(),
  status: text('status').$type<MandateStatus>().notNull().default('ACTIVE'),
  createdAt: createdAt(),
});

export type DebitState = 'SCHEDULED' | 'EXECUTING' | 'PENDING_CONFIRMATION' | 'SUCCEEDED' | 'FAILED';

export const debits = pgTable(
  'debits',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id').notNull().references(() => merchants.id),
    mandateId: text('mandate_id').notNull().references(() => mandates.id),
    amountPaise: money('amount_paise').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').$type<DebitState>().notNull(),
    requestedAt: ts('requested_at').notNull(),
    requestedInPeak: boolean('requested_in_peak').notNull(),
    dueDate: text('due_date'),
    scheduledAt: ts('scheduled_at').notNull(),
    /** IST date stated in the pre-debit notice; execution must happen on this date. */
    noticeDate: text('notice_date').notNull(),
    noticeSentAt: ts('notice_sent_at').notNull(),
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
    quoteId: text('quote_id'),
    state: text('state').$type<PaymentState>().notNull(),
    pspId: text('psp_id'),
    pspTxnId: text('psp_txn_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payments_merchant_idem').on(t.merchantId, t.idempotencyKey)],
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
    createdAt: createdAt(),
  },
  (t) => [index('attempts_debit').on(t.debitId), index('attempts_payment').on(t.paymentId)],
);

export const checkoutQuotes = pgTable('checkout_quotes', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  amountPaise: money('amount_paise').notNull(),
  ruleSetId: text('rule_set_id').notNull(),
  quote: jsonb('quote').notNull(),
  acceptedMethod: text('accepted_method'),
  acceptedAt: ts('accepted_at'),
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
