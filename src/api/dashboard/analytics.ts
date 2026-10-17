import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { slug } from '../../analytics/csv.js';
import { periodFromQuery, periodSpan, type Period } from '../../analytics/period.js';
import type { AppContext } from '../../context.js';
import { merchants } from '../../db/schema.js';
import { userOf } from './plugin.js';

/** Read-only analytics for every dashboard role, always scoped to the user's merchant. */
export const analyticsRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  const period = (req: FastifyRequest): Period => periodFromQuery(req.query, ctx.clock.now());

  app.get('/dashboard/api/analytics/value', async (req) => {
    const merchantId = userOf(req).merchantId;
    const p = period(req);
    const [summary, uplift] = await Promise.all([ctx.analytics.value.summary(merchantId, p), ctx.analytics.value.successUplift(merchantId, p)]);
    return { ...summary, uplift };
  });

  app.get('/dashboard/api/analytics/psps', async (req) => {
    const merchantId = userOf(req).merchantId;
    return ctx.analytics.psps.summary(merchantId, period(req), await ctx.psps.idsFor(merchantId), ctx.health.snapshot());
  });

  app.get('/dashboard/api/analytics/issues', async (req) => ctx.analytics.issues.summary(userOf(req).merchantId, period(req)));

  app.get('/dashboard/api/analytics/settlements', async (req) => ctx.analytics.settlements.summary(userOf(req).merchantId, period(req)));

  /** A CSV download named `<kind>-<merchant>-<period>.csv`. */
  const sendCsv = async (req: FastifyRequest, reply: FastifyReply, kind: string, body: (merchantId: string, p: Period) => Promise<string>) => {
    const merchantId = userOf(req).merchantId;
    const p = period(req);
    const [m] = await ctx.db.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, merchantId));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${kind}-${slug(m?.name ?? '')}-${periodSpan(p)}.csv"`)
      .header('cache-control', 'no-store')
      .send(await body(merchantId, p));
  };

  /** The merchant's pilot: stage, pass criteria and shadow report for the period. */
  app.get('/dashboard/api/pilot', async (req) => {
    const merchantId = userOf(req).merchantId;
    const p = period(req);
    const [rollout, scorecard, report] = await Promise.all([ctx.rollout.get(merchantId), ctx.scorecard.evaluate(merchantId, p), ctx.shadowReport.summary(merchantId, p)]);
    return { rollout, scorecard, report };
  });

  app.get('/dashboard/api/pilot/report.csv', (req, reply) => sendCsv(req, reply, 'shadow-report', (id, p) => ctx.shadowReport.rowsCsv(id, p)));
  app.get('/dashboard/api/analytics/statement.csv', (req, reply) => sendCsv(req, reply, 'statement', (id, p) => ctx.analytics.statement.summaryCsv(id, p)));
  app.get('/dashboard/api/analytics/value-events.csv', (req, reply) => sendCsv(req, reply, 'value-events', (id, p) => ctx.analytics.statement.valueEventsCsv(id, p)));
};
