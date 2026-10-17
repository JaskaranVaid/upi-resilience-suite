import { z } from 'zod';
import { PAYMENT_CHANNELS } from '../psp/types.js';
import { PAYMENT_METHODS } from '../rules/steering.js';
import { MERCHANT_STATUS_LABELS, type MerchantStatus } from '../tracking/derive.js';

/**
 * Response shapes of the core integration objects, as JSON (timestamps are ISO 8601 strings).
 * They feed the OpenAPI document; contract tests parse real responses with them (strict, so a
 * field added to a response without documenting it fails the test).
 */

const timestamp = z.iso.datetime({ offset: true });
const MERCHANT_STATUSES = Object.keys(MERCHANT_STATUS_LABELS) as [MerchantStatus, ...MerchantStatus[]];

export const errorResponse = z
  .object({ error: z.object({ code: z.string().meta({ example: 'VALIDATION' }), message: z.string() }).strict() })
  .strict()
  .meta({ id: 'Error' });

export const customerAction = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('UPI_COLLECT'), vpa: z.string() }).strict(),
    z.object({ type: z.literal('UPI_INTENT'), url: z.string(), appUrls: z.record(z.string(), z.string()) }).strict(),
    z.object({ type: z.literal('UPI_QR'), qrData: z.string().optional(), qrImage: z.string().optional() }).strict(),
    z.object({ type: z.literal('REDIRECT'), url: z.string() }).strict(),
    z.object({ type: z.literal('PSP_CHECKOUT'), provider: z.string(), environment: z.enum(['sandbox', 'production']), params: z.record(z.string(), z.string()) }).strict(),
  ])
  .meta({ id: 'CustomerAction', description: 'What the customer must do to pay; present while the payment is pending.' });

export const customerStatus = z.enum(['processing', 'success', 'failed', 'verification_in_progress', 'refund_processing', 'refunded']).meta({ id: 'CustomerStatus' });

export const paymentResponse = z
  .object({
    id: z.string(),
    orderId: z.string().nullable(),
    amountPaise: z.number().int(),
    channel: z.enum(PAYMENT_CHANNELS),
    payerVpa: z.string().nullable(),
    state: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
    customerAction: customerAction.nullable(),
    pspId: z.string().nullable(),
    pspTxnId: z.string().nullable(),
    lastErrorCode: z.string().nullable(),
    quoteId: z.string().nullable(),
    createdAt: timestamp,
    merchantStatus: z.enum(MERCHANT_STATUSES),
    merchantStatusLabel: z.string(),
    customerDebit: z.enum(['DEBITED', 'NOT_DEBITED', 'UNKNOWN']),
    capture: z.enum(['CAPTURED', 'NOT_CAPTURED', 'UNKNOWN']),
    reversalStatus: z.enum(['NONE', 'INITIATED', 'COMPLETED', 'UNKNOWN']),
    upiRrn: z.string().nullable(),
    /** Only when the payment is created: lets your checkout page read this payment's customer-safe status. */
    customerStatusToken: z.string().optional(),
  })
  .strict()
  .meta({ id: 'Payment' });

export const checkoutPayment = z
  .object({
    id: z.string(),
    method: z.enum(PAYMENT_METHODS),
    channel: z.enum(PAYMENT_CHANNELS),
    amountPaise: z.number().int(),
    status: customerStatus,
    message: z.string(),
    action: customerAction.nullable(),
  })
  .strict()
  .meta({ id: 'CheckoutPayment', description: "The session's current payment, as the customer may see it." });

export const checkoutSessionResponse = z
  .object({
    id: z.string(),
    amountPaise: z.number().int(),
    orderId: z.string().nullable(),
    status: z.enum(['OPEN', 'PAID', 'EXPIRED']),
    expiresAt: timestamp,
    returnUrl: z.string().nullable(),
    methods: z.array(
      z
        .object({
          method: z.enum(PAYMENT_METHODS),
          /** What the customer pays with this method (cart amount minus any steering discount). */
          payablePaise: z.number().int(),
          discountPaise: z.number().int(),
          recommended: z.boolean(),
          upiFlows: z.array(z.enum(['INTENT', 'QR', 'COLLECT'])).optional(),
        })
        .strict(),
    ),
    payment: checkoutPayment.nullable(),
    /** Only from POST /v1/checkout/sessions: give it to checkout.js (it can read and pay this session only). */
    clientToken: z.string().optional(),
  })
  .strict()
  .meta({ id: 'CheckoutSession' });

export const mandateResponse = z
  .object({
    id: z.string(),
    merchantId: z.string(),
    mandateRef: z.string(),
    customerVpa: z.string(),
    maxAmountPaise: z.number().int(),
    eligiblePsps: z.array(z.string()),
    noAfaLimitPaise: z.number().int().nullable(),
    status: z.enum(['ACTIVE', 'PAUSED', 'REVOKED']),
    createdAt: timestamp,
    /** Who executes new debits on this mandate under your current pilot stage. */
    executedBy: z.enum(['MERCHANTFLO', 'MERCHANT']),
  })
  .strict()
  .meta({ id: 'Mandate' });

export const debitResponse = z
  .object({
    id: z.string(),
    mandateId: z.string(),
    orderId: z.string().nullable(),
    amountPaise: z.number().int(),
    state: z.enum(['SCHEDULED', 'EXECUTING', 'PENDING_CONFIRMATION', 'SUCCEEDED', 'FAILED']),
    requestedAt: timestamp,
    requestedInPeak: z.boolean(),
    dueDate: z.string().nullable(),
    /** The off-peak slot Merchantflo picked for the execution. */
    scheduledAt: timestamp,
    noticeDate: z.string().nullable(),
    /** The pre-debit notice is not sent yet (the provider accepts notices only a few days ahead). */
    noticePending: z.boolean(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastErrorCode: z.string().nullable(),
    pspTxnId: z.string().nullable(),
    completedAt: timestamp.nullable(),
    /** Merchantflo sends the notice and executes this debit. Do not execute it yourself. */
    executedBy: z.literal('MERCHANTFLO'),
  })
  .strict()
  .meta({ id: 'Debit' });

export const webhookDeliveryResponse = z
  .object({
    /** Also the `id` in the webhook body: the same across retries and redeliveries. */
    id: z.string(),
    event: z.string(),
    status: z.enum(['pending', 'delivered', 'failed']),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    createdAt: timestamp,
    deliveredAt: timestamp.nullable(),
    failedAt: timestamp.nullable(),
    nextAttemptAt: timestamp.nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()
  .meta({ id: 'WebhookDelivery' });

export const publicPaymentStatus = z
  .object({ paymentId: z.string(), status: customerStatus, message: z.string(), amountPaise: z.number().int(), updatedAt: timestamp })
  .strict()
  .meta({ id: 'PublicPaymentStatus' });

export const rolloutStage = z.enum(['SHADOW', 'CANARY', 'FULL']).meta({
  id: 'RolloutStage',
  description: 'SHADOW: your system executes every debit, Merchantflo only plans. CANARY: Merchantflo executes a fixed share of mandates. FULL: Merchantflo executes all.',
});

export const pilotResponse = z
  .object({
    stage: rolloutStage,
    /** Share of mandates Merchantflo executes while CANARY; null otherwise. */
    canaryPercent: z.number().int().min(1).max(99).nullable(),
    /** When the stage last changed; null if it never has. */
    since: timestamp.nullable(),
  })
  .strict()
  .meta({ id: 'Pilot' });

export const shadowDebitResponse = z
  .object({
    object: z.literal('shadow_debit'),
    id: z.string(),
    /** Your own system executes this debit, as it did before the pilot. Merchantflo never will. */
    executedBy: z.literal('MERCHANT'),
    mandateId: z.string().nullable(),
    mandateRef: z.string(),
    orderId: z.string().nullable(),
    amountPaise: z.number().int(),
    /** MIRRORED: sent to debit intake; REPORTED: known only from an execution report (e.g. a backtest). */
    source: z.enum(['MIRRORED', 'REPORTED']),
    rolloutStage: rolloutStage.nullable(),
    requestedAt: timestamp,
    requestedInPeak: z.boolean(),
    dueDate: z.string().nullable(),
    /** When Merchantflo would have executed it: off-peak, after the notice period. */
    plannedAt: timestamp,
    plannedNoticeDate: z.string(),
    /** Why Merchantflo would have refused it at intake, if it would have. */
    wouldRefuse: z.enum(['MANDATE_INACTIVE', 'AMOUNT_EXCEEDS_MANDATE', 'AFA_REQUIRED']).nullable(),
    /** You reported executing a debit Merchantflo executes: see the pilot guide. */
    misroutedDebitId: z.string().nullable(),
    /** What your system reported (POST /v1/pilot/executions); null until then. */
    outcome: z
      .object({
        status: z.enum(['SUCCEEDED', 'FAILED']),
        executedAt: timestamp,
        failureKind: z.enum(['TECHNICAL', 'BUSINESS', 'UNKNOWN']).nullable(),
        failureCode: z.string().nullable(),
        pspTxnId: z.string().nullable(),
        attempts: z.number().int().nullable(),
        reportedAt: timestamp.nullable(),
      })
      .strict()
      .nullable(),
    createdAt: timestamp,
  })
  .strict()
  .meta({ id: 'ShadowDebit', description: "A debit your own system executes during a pilot, with Merchantflo's plan for it and the outcome you reported." });

const period = z
  .object({
    label: z.string(),
    /** 'YYYY-MM' for a billing month; null for a custom range. */
    month: z.string().nullable(),
    from: timestamp,
    /** Exclusive. */
    to: timestamp,
  })
  .strict();

const count = z.number().int();
const rate = z.number().nullable();
const arm = z.object({ n: count, succeeded: count, rate }).strict();
const criterionBase = {
  label: z.string(),
  /** The bar, in words. */
  target: z.string(),
  status: z.enum(['PASS', 'FAIL', 'PENDING', 'NO_DATA']),
  /** Whether moving to FULL requires it to pass (uplift is reported, not gated). */
  gated: z.boolean(),
  methodNote: z.string(),
};

export const pilotScorecardResponse = z
  .object({
    period,
    criteria: z.array(
      z.discriminatedUnion('key', [
        z.object({ key: z.literal('doubleDebits'), ...criterionBase, details: z.object({ open: count, confirmed: count, dismissed: count }).strict() }).strict(),
        z.object({ key: z.literal('restrictedWindowExecutions'), ...criterionBase, details: z.object({ count }).strict() }).strict(),
        z
          .object({
            key: z.literal('autopayUplift'),
            ...criterionBase,
            details: z
              .object({
                /** Debits Merchantflo executed in CANARY. */
                canary: arm,
                /** Debits your own system executed in CANARY. */
                control: arm,
                /** Canary minus control success rate, and its 95% interval (fractions, not percent). */
                difference: rate,
                low: rate,
                high: rate,
                /** Success-rate uplift from Merchantflo's recovery on its own traffic, in percentage points (context). */
                recoveryUpliftPp: rate,
              })
              .strict(),
          })
          .strict(),
        z
          .object({
            key: z.literal('webhooksOnTime'),
            ...criterionBase,
            details: z.object({ judged: count, onTime: count, late: count, failed: count, share: rate }).strict(),
          })
          .strict(),
        z
          .object({
            key: z.literal('statementReconciles'),
            ...criterionBase,
            details: z
              .object({ payments: count, reconciled: count, awaiting: count, overdue: count, mismatched: count, valueEvents: count, unverifiable: count })
              .strict(),
          })
          .strict(),
      ]),
    ),
    /** Every gated criterion passes. */
    passed: z.boolean(),
  })
  .strict()
  .meta({ id: 'PilotScorecard', description: 'The five pilot pass criteria for a period, each with its numbers and how it is measured.' });

export const shadowReportResponse = z
  .object({
    period,
    /** Your reported executions in the period (by execution time). */
    observed: z.object({ count, amountPaise: count, succeeded: count, successRate: rate }).strict(),
    /** Every execution falls in exactly one class. */
    classes: z.array(
      z
        .object({
          key: z.enum(['PEAK_RESCUE', 'RETRY_RECOVERABLE', 'PEAK_RISK', 'WOULD_REFUSE', 'BUSINESS_DECLINE', 'UNCLASSIFIED_FAILURE', 'NO_CHANGE']),
          label: z.string(),
          value: z.enum(['CERTAIN', 'POTENTIAL', 'NONE']),
          methodNote: z.string(),
          count,
          amountPaise: count,
        })
        .strict(),
    ),
    /** Value Merchantflo would certainly have protected. */
    certainPaise: count,
    /** Value it could have protected at most: an upper bound, never added to the certain value. */
    potentialPaise: count,
    /** Potential value × your measured recovery rate on live Merchantflo debits; null without enough live traffic. */
    estimate: z.object({ recoveryRate: z.number(), sample: count, amountPaise: count }).strict().nullable(),
    estimateNote: z.string(),
    projectedSuccessRate: z.object({ atLeast: rate, atMost: rate }).strict(),
    bySource: z.object({ MIRRORED: count, REPORTED: count }).strict(),
    /** Shadow debits requested in the period whose outcome you have not reported. */
    awaitingOutcome: count,
    outcomeCoverage: rate,
    coverageNote: z.string(),
  })
  .strict()
  .meta({ id: 'ShadowReport', description: 'What Merchantflo would have saved on the debits your own system executed, classified conservatively.' });
