import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';

/** Dashboard data routes (overview, payments, cases). Registered inside the authenticated dashboard plugin. */
export const dashboardDataRoutes = (_ctx: AppContext) => async (_app: FastifyInstance) => {};
