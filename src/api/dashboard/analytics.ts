import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { slug } from '../../analytics/csv.js';
import { resolvePeriod, type Period } from '../../analytics/period.js';
import type { AppContext } from '../../context.js';
import { merchants } from '../../db/schema.js';
import { userOf } from './plugin.js';

const periodQuery = z.object({
  month: z.string().max(7).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

/** Read-only analytics for every dashboard role, always scoped to the user's merchant. */
export const analyticsRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  const period = (req: FastifyRequest): Period => {
    const q = periodQuery.parse(req.query);
    return resolvePeriod({ ...(q.month ? { month: q.month } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }, ctx.clock.now());
  };

  app.get('/dashboard/api/analytics/value', async (req) => {
    const merchantId = userOf(req).merchantId;
    const p = period(req);
    const [summary, uplift] = await Promise.all([ctx.analytics.value.summary(merchantId, p), ctx.analytics.value.successUplift(merchantId, p)]);
    return { ...summary, uplift };
  });

  app.get('/dashboard/api/analytics/psps', async (req) =>
    ctx.analytics.psps.summary(userOf(req).merchantId, period(req), ctx.pspIds, ctx.health.snapshot()),
  );

  app.get('/dashboard/api/analytics/issues', async (req) => ctx.analytics.issues.summary(userOf(req).merchantId, period(req)));

  const sendCsv = async (req: FastifyRequest, reply: FastifyReply, kind: 'statement' | 'value-events') => {
    const merchantId = userOf(req).merchantId;
    const p = period(req);
    const [m] = await ctx.db.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, merchantId));
    const span = p.month ?? `${p.days[0]}_${p.days.at(-1)}`;
    const body = kind === 'statement' ? await ctx.analytics.statement.summaryCsv(merchantId, p) : await ctx.analytics.statement.valueEventsCsv(merchantId, p);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${kind}-${slug(m?.name ?? '')}-${span}.csv"`)
      .header('cache-control', 'no-store')
      .send(body);
  };

  app.get('/dashboard/api/analytics/statement.csv', (req, reply) => sendCsv(req, reply, 'statement'));
  app.get('/dashboard/api/analytics/value-events.csv', (req, reply) => sendCsv(req, reply, 'value-events'));
};
