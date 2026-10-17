import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { shadowDebitView } from '../../pilot/shadow.js';
import { executionReportsBody, fromCsvRow } from '../../pilot/executions.js';
import { parseCsv } from '../../mandates/csv.js';
import { AppError } from '../../errors.js';
import { periodFromQuery } from '../../analytics/period.js';
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
  // CSV bodies for execution reports (scoped to these routes).
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/v1/pilot', async (req) => ctx.rollout.get(merchantOf(req).id));

  /** The pilot's pass criteria for a period (default: this IST month). */
  app.get('/v1/pilot/scorecard', async (req) => ctx.scorecard.evaluate(merchantOf(req).id, periodFromQuery(req.query, ctx.clock.now())));

  /** What Merchantflo would have saved on the debits your own system executed (default: this IST month). */
  app.get('/v1/pilot/report', async (req) => ctx.shadowReport.summary(merchantOf(req).id, periodFromQuery(req.query, ctx.clock.now())));

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

  /**
   * What your own system did with debits it executes (shadow debits), or history for a backtest.
   * JSON `{ executions: [...] }` or `text/csv` with the documented header. Each item is judged on its own.
   */
  app.post('/v1/pilot/executions', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const merchant = merchantOf(req);
    let items: unknown[];
    if (typeof req.body === 'string') {
      try {
        items = parseCsv(req.body).map(fromCsvRow);
      } catch (e) {
        throw new AppError('VALIDATION', e instanceof Error ? e.message : 'Invalid CSV');
      }
      if (items.length === 0) throw new AppError('VALIDATION', 'No executions to report');
    } else {
      items = executionReportsBody.parse(req.body).executions;
    }
    return ctx.executionReports.report(merchant.id, items);
  });
};
