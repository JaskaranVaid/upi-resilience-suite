import { z } from 'zod';
import { PAYMENT_METHODS } from '../rules/steering.js';

export const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positivePaise = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const category = z.enum(['GENERAL', 'EXEMPT_SECTOR', 'CAPITAL_MARKETS', 'P2P']);
export const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const vpa = z.string().regex(/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/, 'invalid UPI VPA');
export const idempotencyKey = z.string().min(1).max(255);

const feeSpec = z.object({ percentBps: z.number().int().min(0).max(10_000), flatPaise: paise, capPaise: paise.optional() });

export const createMerchant = z.object({
  name: z.string().min(1).max(200),
  webhookUrl: z.url().optional(),
  category: category.default('GENERAL'),
  smallMerchant: z.boolean().default(false),
  methodCosts: z
    .object({ NETBANKING: feeSpec.optional(), RUPAY_DEBIT: feeSpec.optional(), CARD: feeSpec.optional() })
    .default({}),
  steering: z
    .object({
      enabled: z.boolean(),
      shareBps: z.number().int().min(0).max(10_000),
      minSavingsPaise: paise,
      maxDiscountPaise: paise,
    })
    .partial()
    .default({}),
});

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

export const splitRequest = z.object({
  lineItems: z
    .array(z.object({ vendorId: z.string().min(1), amountPaise: positivePaise, sku: z.string().optional() }))
    .min(1)
    .max(500),
});

export const createPayment = z.object({
  amountPaise: positivePaise,
  payerVpa: vpa,
  idempotencyKey,
  orderId: orderId.optional(),
  quoteId: z.string().optional(),
});

export const savingsQuery = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

export const idParam = z.object({ id: z.string().min(1) });
