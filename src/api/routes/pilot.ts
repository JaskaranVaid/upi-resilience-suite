import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { merchantOf } from '../app.js';

/** The merchant's pilot (Phase 7): rollout stage, shadow debits, reported executions and the scorecard. */
export const pilotRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.get('/v1/pilot', async (req) => ctx.rollout.get(merchantOf(req).id));
};
