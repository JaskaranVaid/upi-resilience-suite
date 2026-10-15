import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { getRuleSet, MDR_2026, mdrStatus } from '../../config/rules.js';
import { savingsSummary } from '../../ledger/savings.js';
import { merchantOf } from '../app.js';
import { savingsQuery } from '../schemas.js';

export const opsRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.get('/health', async () => {
    await ctx.db.execute(sql`select 1`);
    return { status: 'ok', time: ctx.clock.now(), ruleSet: getRuleSet(ctx.clock.now()).id };
  });

  app.get('/v1/psps/health', async () => {
    const known = new Map(ctx.health.snapshot().map((s) => [s.pspId, s]));
    return {
      data: ctx.pspIds.map((pspId) => known.get(pspId) ?? { pspId, state: ctx.health.state(pspId), score: ctx.health.score(pspId), samples: 0 }),
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
