import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { getRuleSet, MDR_2026, mdrStatus } from '../../config/rules.js';
import { savingsSummary } from '../../ledger/savings.js';
import { collectOpsMetrics } from '../../ops/metrics.js';
import { merchantOf, requireAdmin } from '../app.js';
import { savingsQuery } from '../schemas.js';

export const opsRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  // Probes run every few seconds from the load balancer and container runtime: keep them out of the logs.
  /** Liveness: the process is up and serving. Never touches the database, so a database outage doesn't restart every task. */
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  /** Readiness: send traffic here. Fails while shutting down (draining) or when the database is unreachable. */
  app.get('/readyz', { logLevel: 'silent' }, async (_req, reply) => {
    if (ctx.lifecycle.draining) return reply.status(503).send({ status: 'draining' });
    try {
      await ctx.db.execute(sql`select 1`);
    } catch (e) {
      // The route's own logger is silenced (probe noise); this one isn't.
      app.log.warn({ err: e }, 'readiness: database unreachable');
      return reply.status(503).send({ status: 'unavailable' });
    }
    return { status: 'ready' };
  });

  app.get('/health', async () => {
    await ctx.db.execute(sql`select 1`);
    return { status: 'ok', time: ctx.clock.now(), ruleSet: getRuleSet(ctx.clock.now()).id };
  });

  /** Operator view of the gauges the production alarms watch (the worker also logs them every minute). */
  app.get('/v1/admin/ops/metrics', async (req) => {
    requireAdmin(ctx, req);
    return collectOpsMetrics({ db: ctx.db, clock: ctx.clock, health: ctx.health });
  });

  app.get('/v1/psps/health', async (req) => {
    const known = new Map(ctx.health.snapshot().map((s) => [s.pspId, s]));
    const ids = await ctx.psps.idsFor(merchantOf(req).id);
    return {
      data: ids.map((pspId) => known.get(pspId) ?? { pspId, state: ctx.health.state(pspId), score: ctx.health.score(pspId), samples: 0 }),
    };
  });

  /** Value delivered — the basis for proving ROI (and for Phase 4 analytics). */
  app.get('/v1/savings', async (req) => {
    const merchant = merchantOf(req);
    const q = savingsQuery.parse(req.query);
    return savingsSummary(ctx.db, merchant.id, q.from ? new Date(q.from) : undefined, q.to ? new Date(q.to) : undefined);
  });

  /** The regulatory parameters currently applied, so merchants can audit our maths. */
  app.get('/v1/rules', async () => {
    const now = ctx.clock.now();
    const r = getRuleSet(now);
    const m = mdrStatus(now);
    return {
      id: r.id,
      effectiveFrom: r.effectiveFrom,
      windows: r.windows,
      mdr: r.mdr,
      // Whether the UPI MDR regime applies now, is scheduled, or has no confirmed start date yet.
      mdrRegime: { status: m.status, effectiveFrom: m.effectiveFrom, slabs: MDR_2026 },
      preDebitNoticeHours: r.preDebitNoticeHours,
    };
  });
};
