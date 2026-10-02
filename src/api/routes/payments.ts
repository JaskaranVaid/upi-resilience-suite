import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { customerToken } from '../../payments/customer-token.js';
import { paymentView, type Payment } from '../../payments/service.js';
import { merchantOf } from '../app.js';
import { createPayment, idParam } from '../schemas.js';
import { withIdempotencyKey } from './mandates.js';

export const paymentRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  /** Phase 2 view plus Phase 3 fields (additive — existing fields are unchanged). */
  const view = async (merchantId: string, p: Payment) => {
    const row = await ctx.queries.rowFor(merchantId, 'COLLECT', p.id);
    return {
      ...paymentView(p),
      merchantStatus: row.merchantStatus,
      merchantStatusLabel: row.merchantStatusLabel,
      customerDebit: row.customerDebit,
      capture: row.capture,
      reversalStatus: row.reversalStatus,
      upiRrn: row.upiRrn,
    };
  };

  /** One-off UPI collect via the smart router (failover + safe timeout retry). */
  app.post('/v1/payments', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createPayment.parse(withIdempotencyKey(req));
    const { payment, created } = await ctx.payments.create(merchant.id, body);
    return reply.status(created ? 201 : 200).send({
      ...(await view(merchant.id, payment)),
      // Hand this to the checkout page; it can read only this payment's customer-safe status.
      customerStatusToken: customerToken(ctx.customerTokenSecret, payment.id),
    });
  });

  app.get('/v1/payments/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    return view(merchant.id, await ctx.payments.get(merchant.id, id));
  });
};
