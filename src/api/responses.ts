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
