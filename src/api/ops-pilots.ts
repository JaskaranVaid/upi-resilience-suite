import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { slug } from '../analytics/csv.js';
import { periodFromQuery, periodSpan } from '../analytics/period.js';
import type { AppContext } from '../context.js';
import { merchants, type RolloutStage } from '../db/schema.js';
import { AppError } from '../errors.js';
import { duplicateView } from '../pilot/duplicates.js';
import { rolloutChangeView } from '../pilot/rollout.js';
import { CAN_ACT, requireOperatorRole } from './ops-auth.js';

const merchantParam = z.object({ merchantId: z.string().min(1).max(100) });
const stageBody = z
  .object({
    stage: z.enum(['SHADOW', 'CANARY', 'FULL']),
    canaryPercent: z.number().int().nullable().optional(),
    reason: z.string().min(1).max(500),
    override: z.boolean().optional(),
  })
  .strict();
const duplicatesQuery = z.object({
  status: z.enum(['OPEN', 'CONFIRMED', 'DISMISSED']).optional(),
  merchantId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const resolveBody = z.object({ resolution: z.enum(['CONFIRMED', 'DISMISSED']), note: z.string().min(1).max(2000) }).strict();

type PilotRow = { id: string; name: string; mode: string; rollout_stage: RolloutStage; canary_percent: number | null; since: Date | string | null; open_suspects: unknown };

/**
 * Pilots in the ops console: every merchant in a pilot (not FULL, or with a rollout history), its
 * scorecard, shadow report, stage history and gates, the stage change itself, and the queue of
 * suspected double debits. Registered inside the ops console API, whose hook signs operators in.
 */
export const opsPilotsApi = (ctx: AppContext) => async (app: FastifyInstance) => {
  const merchantOr404 = async (merchantId: string) => {
    const [m] = await ctx.db.select({ id: merchants.id, name: merchants.name, mode: merchants.mode, webhookUrl: merchants.webhookUrl }).from(merchants).where(eq(merchants.id, merchantId));
    if (!m) throw new AppError('NOT_FOUND', `Merchant ${merchantId} not found`);
    return m;
  };

  app.get('/ops/api/pilots', async () => {
    const r = (await ctx.db.execute(sql`
      select m.id, m.name, m.mode, m.rollout_stage, m.canary_percent,
        (select max(c.created_at) from rollout_changes c where c.merchant_id = m.id) as since,
        (select count(*) from duplicate_suspects d where d.merchant_id = m.id and d.status = 'OPEN') as open_suspects
      from merchants m
      where m.rollout_stage <> 'FULL' or exists (select 1 from rollout_changes c where c.merchant_id = m.id)
      order by m.name, m.id
    `)) as unknown as { rows: PilotRow[] };
    return {
      data: r.rows.map((p) => ({
        merchantId: p.id,
        name: p.name,
        mode: p.mode,
        stage: p.rollout_stage,
        canaryPercent: p.canary_percent,
        since: p.since ? new Date(p.since).toISOString() : null,
        openSuspects: Number(p.open_suspects),
      })),
    };
  });

  app.get('/ops/api/pilots/:merchantId', async (req) => {
    const { merchantId } = merchantParam.parse(req.params);
    const m = await merchantOr404(merchantId);
    const period = periodFromQuery(req.query, ctx.clock.now());
    const [rollout, history, next, scorecard, report, suspects] = await Promise.all([
      ctx.rollout.get(merchantId),
      ctx.rollout.history(merchantId),
      ctx.rollout.nextStep(merchantId),
      ctx.scorecard.evaluate(merchantId, period),
      ctx.shadowReport.summary(merchantId, period),
      ctx.duplicates.list({ merchantId, limit: 50 }),
    ]);
    return {
      merchant: { id: m.id, name: m.name, mode: m.mode, hasWebhookUrl: Boolean(m.webhookUrl) },
      rollout,
      /** Newest first. */
      history: history.map(rolloutChangeView).reverse(),
      next,
      scorecard,
      report,
      duplicates: suspects.map(duplicateView),
    };
  });

  app.post('/ops/api/pilots/:merchantId/stage', async (req) => {
    const o = requireOperatorRole(req, CAN_ACT);
    const { merchantId } = merchantParam.parse(req.params);
    const body = stageBody.parse(req.body);
    const m = await ctx.rollout.change(merchantId, body, { operatorId: o.id, role: o.role });
    return { stage: m.rolloutStage, canaryPercent: m.canaryPercent };
  });

  app.get('/ops/api/pilots/:merchantId/report.csv', async (req, reply) => {
    const { merchantId } = merchantParam.parse(req.params);
    const m = await merchantOr404(merchantId);
    const period = periodFromQuery(req.query, ctx.clock.now());
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="shadow-report-${slug(m.name)}-${periodSpan(period)}.csv"`)
      .header('cache-control', 'no-store')
      .send(await ctx.shadowReport.rowsCsv(merchantId, period));
  });

  app.get('/ops/api/duplicates', async (req) => {
    const q = duplicatesQuery.parse(req.query);
    const rows = await ctx.duplicates.list(q);
    const ids = [...new Set(rows.map((r) => r.merchantId))];
    const names = ids.length ? await ctx.db.select({ id: merchants.id, name: merchants.name }).from(merchants).where(inArray(merchants.id, ids)) : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return { data: rows.map((r) => ({ ...duplicateView(r), merchantName: nameOf.get(r.merchantId) ?? null })) };
  });

  app.post('/ops/api/duplicates/:id/resolve', async (req) => {
    const o = requireOperatorRole(req, CAN_ACT);
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const body = resolveBody.parse(req.body);
    return duplicateView(await ctx.duplicates.resolve(id, body, o.id));
  });
};
