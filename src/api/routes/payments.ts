import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { paymentView } from '../../payments/service.js';
import { merchantOf } from '../app.js';
import { createPayment, idParam } from '../schemas.js';
import { withIdempotencyKey } from './mandates.js';

export const paymentRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  /** One-off UPI collect via the smart router (failover + safe timeout retry). */
  app.post('/v1/payments', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createPayment.parse(withIdempotencyKey(req));
    const { payment, created } = await ctx.payments.create(merchant.id, body);
    return reply.status(created ? 201 : 200).send(paymentView(payment));
  });

  app.get('/v1/payments/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    return paymentView(await ctx.payments.get(merchant.id, id));
  });
};
