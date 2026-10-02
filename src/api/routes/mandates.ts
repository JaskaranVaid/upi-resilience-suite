import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { debits, mandates } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { debitView } from '../../scheduler/service.js';
import { merchantOf } from '../app.js';
import { createDebit, createMandate, idParam } from '../schemas.js';

/** Accept the idempotency key from the body or the conventional Idempotency-Key header. */
export function withIdempotencyKey(req: FastifyRequest): unknown {
  const header = req.headers['idempotency-key'];
  const body = (req.body ?? {}) as Record<string, unknown>;
  return typeof header === 'string' && body.idempotencyKey === undefined ? { ...body, idempotencyKey: header } : body;
}

export const mandateRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.post('/v1/mandates', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createMandate.parse(req.body);
    const eligiblePsps = body.eligiblePsps ?? ctx.pspIds;
    const unknown = eligiblePsps.filter((p) => !ctx.pspIds.includes(p));
    if (unknown.length) throw new AppError('VALIDATION', `Unknown PSPs: ${unknown.join(', ')}`);
    const [m] = await ctx.db
      .insert(mandates)
      .values({ id: newId('mdt'), merchantId: merchant.id, ...body, eligiblePsps, createdAt: ctx.clock.now() })
      .returning();
    return reply.status(201).send(m);
  });

  app.get('/v1/mandates/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    const [m] = await ctx.db.select().from(mandates).where(and(eq(mandates.id, id), eq(mandates.merchantId, merchant.id)));
    if (!m) throw new AppError('NOT_FOUND', `Mandate ${id} not found`);
    return m;
  });

  app.post('/v1/mandates/:id/revoke', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    const [m] = await ctx.db
      .update(mandates)
      .set({ status: 'REVOKED' })
      .where(and(eq(mandates.id, id), eq(mandates.merchantId, merchant.id)))
      .returning();
    if (!m) throw new AppError('NOT_FOUND', `Mandate ${id} not found`);
    return m;
  });

  /**
   * Engine A intake. Point your billing system here instead of at the PSP: we pick a
   * compliant off-peak slot, send the pre-debit notice, and execute it for you.
   */
  app.post('/v1/mandates/:id/debits', async (req, reply) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    const body = createDebit.parse(withIdempotencyKey(req));
    const { debit, created } = await ctx.scheduler.createDebit(merchant.id, id, body);
    return reply.status(created ? 201 : 200).send(debitView(debit));
  });

  app.get('/v1/debits/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    return debitView(await ctx.scheduler.getDebit(merchant.id, id));
  });

  app.get('/v1/debits', async (req) => {
    const merchant = merchantOf(req);
    const q = z
      .object({
        state: z.enum(['SCHEDULED', 'EXECUTING', 'PENDING_CONFIRMATION', 'SUCCEEDED', 'FAILED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const rows = await ctx.db
      .select()
      .from(debits)
      .where(and(eq(debits.merchantId, merchant.id), q.state ? eq(debits.state, q.state) : undefined))
      .orderBy(desc(debits.createdAt))
      .limit(q.limit);
    return { data: rows.map(debitView) };
  });
};
