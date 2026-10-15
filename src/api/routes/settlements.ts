import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { settlements } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { merchantOf } from '../app.js';

const query = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** matched = tied to one of your payments; unmatched = in the PSP report but not ours. */
  match: z.enum(['all', 'matched', 'unmatched']).default('all'),
  /** Page backwards from this settlement line id (from the previous page's nextBefore). */
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Settlement report lines from the merchant's PSPs, as reconciled. */
export const settlementRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.get('/v1/settlements', async (req) => {
    const merchant = merchantOf(req);
    const q = query.parse(req.query);
    const to = q.to ? new Date(q.to) : ctx.clock.now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (to <= from) throw new AppError('VALIDATION', '"to" must be after "from"');
    const conds = [eq(settlements.merchantId, merchant.id), gte(settlements.settledAt, from), lt(settlements.settledAt, to)];
    if (q.match === 'matched') conds.push(isNotNull(settlements.subjectId));
    if (q.match === 'unmatched') conds.push(isNull(settlements.subjectId));
    if (q.before) {
      const [b] = await ctx.db.select({ settledAt: settlements.settledAt }).from(settlements).where(and(eq(settlements.id, q.before), eq(settlements.merchantId, merchant.id)));
      if (!b?.settledAt) throw new AppError('VALIDATION', 'Unknown "before" cursor');
      conds.push(or(lt(settlements.settledAt, b.settledAt), and(eq(settlements.settledAt, b.settledAt), lt(settlements.id, q.before)))!);
    }
    const rows = await ctx.db.select().from(settlements).where(and(...conds)).orderBy(desc(settlements.settledAt), desc(settlements.id)).limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((s) => ({
        id: s.id,
        pspId: s.pspId,
        kind: s.kind,
        amountPaise: s.amountPaise,
        feePaise: s.feePaise,
        taxPaise: s.taxPaise,
        settledAmountPaise: s.settledAmountPaise,
        utr: s.utr,
        settlementId: s.settlementId,
        settledAt: s.settledAt,
        pspPaymentId: s.pspPaymentId,
        payment: s.subjectId ? { type: s.subjectType, id: s.subjectId } : null,
      })),
      nextBefore: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  });
};
