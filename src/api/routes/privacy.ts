import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { merchantOf } from '../app.js';
import { vpa } from '../schemas.js';

/** A phone number as people write it: 10 digits, optionally with +91, spaces or dashes. */
const phone = z
  .string()
  .max(32)
  .regex(/^\+?[\d\s-]+$/, 'expected a phone number')
  .refine((p) => p.replace(/\D/g, '').length >= 10, 'expected at least 10 digits');

/** Who to erase: shared with the ops console's erasure form. */
export const erasureFields = { vpa: z.string().trim().pipe(vpa).optional(), phone: phone.optional() };
export const needsIdentifier = (b: { vpa?: string; phone?: string }) => b.vpa !== undefined || b.phone !== undefined;

export const erasureRequest = z.object(erasureFields).strict().refine(needsIdentifier, 'give vpa, phone or both');

export const erasureResponse = z
  .object({ mandates: z.number().int(), payments: z.number().int(), checkoutSessions: z.number().int(), webhookDeliveries: z.number().int() })
  .strict()
  .meta({ id: 'ErasureResult', description: 'How many of your records had the customer’s identifiers removed.' });

/** DPDP erasure on a customer's request, made by the merchant (the data fiduciary). */
export const privacyRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.post('/v1/privacy/erasure', async (req) => {
    const merchant = merchantOf(req);
    const body = erasureRequest.parse(req.body);
    return ctx.privacy.erase(merchant.id, body, { type: 'API_KEY', id: merchant.id });
  });
};
