import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { merchantOf } from '../app.js';
import { idParam } from '../schemas.js';

export const listDeliveriesQuery = z.object({
  status: z.enum(['pending', 'delivered', 'failed']).optional(),
  event: z.string().max(100).optional(),
  /** Page backwards from this delivery id (the previous page's nextBefore). */
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** The merchant's webhook delivery log, and redelivery. */
export const webhookDeliveryRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.get('/v1/webhook-deliveries', async (req) => ctx.webhookDeliveries.list(merchantOf(req).id, listDeliveriesQuery.parse(req.query)));

  app.post('/v1/webhook-deliveries/:id/redeliver', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    return reply.status(202).send(await ctx.webhookDeliveries.redeliver(merchantOf(req).id, id));
  });
};
