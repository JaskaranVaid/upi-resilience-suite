import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { shadowDebitView } from '../../pilot/shadow.js';
import { merchantOf } from '../app.js';
import { idParam } from '../schemas.js';

export const listShadowDebitsQuery = z.object({
  /** Only debits whose outcome you have (true) or have not yet (false) reported. */
  reported: z.enum(['true', 'false']).optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The merchant's pilot (Phase 7): rollout stage, shadow debits, reported executions and the scorecard. */
export const pilotRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.get('/v1/pilot', async (req) => ctx.rollout.get(merchantOf(req).id));

  app.get('/v1/shadow-debits', async (req) => {
    const q = listShadowDebitsQuery.parse(req.query);
    return ctx.shadow.list(merchantOf(req).id, {
      limit: q.limit,
      ...(q.before ? { before: q.before } : {}),
      ...(q.reported ? { reported: q.reported === 'true' } : {}),
    });
  });

  app.get('/v1/shadow-debits/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return shadowDebitView(await ctx.shadow.get(merchantOf(req).id, id));
  });
};
