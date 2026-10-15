import { z } from 'zod';
import { AUTOPAY_NO_AFA_MAX_PAISE } from '../config/rules.js';
import { PAYMENT_METHODS } from '../rules/steering.js';
import { PAYMENT_CHANNELS } from '../psp/types.js';

export const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positivePaise = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const category = z.enum(['GENERAL', 'EXEMPT_SECTOR', 'CAPITAL_MARKETS', 'P2P']);
export const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const vpa = z.string().regex(/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/, 'invalid UPI VPA');
export const idempotencyKey = z.string().min(1).max(255);

const feeSpec = z.object({ percentBps: z.number().int().min(0).max(10_000), flatPaise: paise, capPaise: paise.optional() });

const methodCosts = z.object({ NETBANKING: feeSpec.optional(), RUPAY_DEBIT: feeSpec.optional(), CARD: feeSpec.optional() });
const steering = z
  .object({
    enabled: z.boolean(),
    shareBps: z.number().int().min(0).max(10_000),
    minSavingsPaise: paise,
    maxDiscountPaise: paise,
  })
  .partial();

export const createMerchant = z.object({
  name: z.string().min(1).max(200),
  /** TEST (default) uses sandbox/mock PSPs only; LIVE only the merchant's own production PSP accounts. */
  mode: z.enum(['TEST', 'LIVE']).default('TEST'),
  webhookUrl: z.url().optional(),
  category: category.default('GENERAL'),
  smallMerchant: z.boolean().default(false),
  methodCosts: methodCosts.default({}),
  steering: steering.default({}),
});

/** Merchant self-service settings. Mode is not editable: test and live are separate merchants. */
export const updateMerchant = z
  .object({
    name: z.string().min(1).max(200),
    /** null removes the webhook URL (webhooks then stop being delivered). */
    webhookUrl: z.url().nullable(),
    category,
    smallMerchant: z.boolean(),
    /** Replaces the method cost table. */
    methodCosts,
    /** Merged into the current steering settings. */
    steering,
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const createVendor = z.object({
  externalId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  category: category.default('GENERAL'),
  smallMerchant: z.boolean().default(false),
});

export const createMandate = z.object({
  mandateRef: z.string().min(1).max(200),
  customerVpa: vpa,
  maxAmountPaise: positivePaise,
  /** Omit to allow every configured PSP (MIC-portable mandate). */
  eligiblePsps: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Raise the no-authentication debit limit for categories the merchant declares eligible
   * (mutual funds, insurance premiums, credit card bills), up to ₹1 lakh.
   */
  noAfaLimitPaise: positivePaise.max(AUTOPAY_NO_AFA_MAX_PAISE, 'cannot exceed ₹1,00,000').optional(),
});

export const orderId = z.string().min(1).max(200);

export const createDebit = z.object({
  amountPaise: positivePaise,
  idempotencyKey,
  dueDate: istDate.optional(),
  orderId: orderId.optional(),
});

export const quoteRequest = z.object({ amountPaise: positivePaise });

export const acceptQuote = z.object({ method: z.enum(PAYMENT_METHODS) });

export const createCheckoutSession = z
  .object({
    amountPaise: positivePaise,
    orderId: z.string().min(1).max(200).optional(),
    /** Prefills what the customer would otherwise type; phone is required by some PSPs. */
    customer: z.object({ phone: z.string().regex(/^(\d{10}|\+\d{8,15})$/).optional(), vpa: vpa.optional() }).optional(),
    /** Where checkout.js sends the customer after the payment completes. */
    returnUrl: z.url().optional(),
    expiresInMinutes: z.number().int().min(5).max(24 * 60).optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const quotePaid = z.object({ method: z.enum(PAYMENT_METHODS), paymentReference: z.string().min(1).max(200) });

export const splitRequest = z.object({
  lineItems: z
    .array(z.object({ vendorId: z.string().min(1), amountPaise: positivePaise, sku: z.string().optional() }))
    .min(1)
    .max(500),
});

export const createPayment = z.object({
  amountPaise: positivePaise,
  /** How the customer pays. Default: UPI_COLLECT when payerVpa is given, else UPI_INTENT. */
  channel: z.enum(PAYMENT_CHANNELS).optional(),
  /** Required for UPI_COLLECT. */
  payerVpa: vpa.optional(),
  /** NETBANKING directly to this bank (the PSP's bank code). */
  netbankingBankCode: z.string().min(1).max(20).optional(),
  /** The customer's device, which some PSPs (e.g. Razorpay server-to-server UPI) require. */
  client: z.object({ ip: z.union([z.ipv4(), z.ipv6()]).optional(), userAgent: z.string().max(500).optional() }).optional(),
  idempotencyKey,
  orderId: orderId.optional(),
  quoteId: z.string().optional(),
  /** Required when a configured PSP needs it (e.g. Cashfree): 10 digits, or + and country code. */
  customerPhone: z.string().regex(/^(\d{10}|\+\d{8,15})$/, 'expected 10 digits or +<country code><number>').optional(),
});

export const savingsQuery = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

export const idParam = z.object({ id: z.string().min(1) });
