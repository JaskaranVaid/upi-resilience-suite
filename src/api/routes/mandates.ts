import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { debits, mandates } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { debitView } from '../../scheduler/service.js';
import { merchantOf } from '../app.js';
import { createDebit, createMandate, idParam, positivePaise } from '../schemas.js';
import { resolveEligiblePsps } from '../../mandates/eligibility.js';
import { parseCsv } from '../../mandates/csv.js';
import { fromCsvRow } from '../../mandates/import.js';

/** Accept the idempotency key from the body or the conventional Idempotency-Key header. */
export function withIdempotencyKey(req: FastifyRequest): unknown {
  const header = req.headers['idempotency-key'];
  const body = (req.body ?? {}) as Record<string, unknown>;
  return typeof header === 'string' && body.idempotencyKey === undefined ? { ...body, idempotencyKey: header } : body;
}

export const importMandatesBody = z.object({ mandates: z.array(z.unknown()).min(1), verify: z.boolean().default(false) });
export const importMandatesQuery = z.object({ verify: z.enum(['true', 'false']).default('false') });
export const updateMandateBody = z
  .object({ eligiblePsps: z.array(z.string().min(1)).min(1), maxAmountPaise: positivePaise, noAfaLimitPaise: createMandate.shape.noAfaLimitPaise.unwrap().nullable() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');
export const movePspBody = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
export const listDebitsQuery = z.object({
  state: z.enum(['SCHEDULED', 'EXECUTING', 'PENDING_CONFIRMATION', 'SUCCEEDED', 'FAILED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const mandateRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  // CSV bodies for bulk import (scoped to these routes).
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  /**
   * Bulk import of mandates that already exist at the merchant's PSP. JSON
   * `{ mandates: [...], verify? }` or `text/csv` (`?verify=true`) with header
   * `mandateRef,customerVpa,maxAmountPaise,eligiblePsps,noAfaLimitPaise`. Idempotent per mandateRef.
   */
  app.post('/v1/mandates/import', { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const merchant = merchantOf(req);
    let rows: unknown[];
    let verify: boolean;
    if (typeof req.body === 'string') {
      try {
        rows = parseCsv(req.body).map(fromCsvRow);
      } catch (e) {
        throw new AppError('VALIDATION', e instanceof Error ? e.message : 'Invalid CSV');
      }
      verify = importMandatesQuery.parse(req.query).verify === 'true';
    } else {
      const body = importMandatesBody.parse(req.body);
      rows = body.mandates;
      verify = body.verify;
    }
    if (rows.length === 0) throw new AppError('VALIDATION', 'No mandates to import');
    return ctx.mandateImporter.import(merchant.id, rows, { verify });
  });

  app.post('/v1/mandates', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createMandate.parse(req.body);
    const available = new Map((await ctx.psps.requireForMerchant(merchant.id)).map((a) => [a.id, a]));
    const eligiblePsps = resolveEligiblePsps(available, body.eligiblePsps);
    const [m] = await ctx.db
      .insert(mandates)
      .values({ id: newId('mdt'), merchantId: merchant.id, ...body, eligiblePsps, createdAt: ctx.clock.now() })
      .onConflictDoNothing({ target: [mandates.merchantId, mandates.mandateRef] })
      .returning();
    if (!m) {
      const [existing] = await ctx.db
        .select({ id: mandates.id })
        .from(mandates)
        .where(and(eq(mandates.merchantId, merchant.id), eq(mandates.mandateRef, body.mandateRef)));
      throw new AppError('CONFLICT', `Mandate ${body.mandateRef} is already registered as ${existing?.id}`);
    }
    return reply.status(201).send(m);
  });

  /** Change which of the merchant's PSPs may execute a mandate, or its limits. */
  app.patch('/v1/mandates/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    const body = updateMandateBody.parse(req.body);
    const available = new Map((await ctx.psps.requireForMerchant(merchant.id)).map((a) => [a.id, a]));
    const patch = { ...body, ...(body.eligiblePsps ? { eligiblePsps: resolveEligiblePsps(available, body.eligiblePsps) } : {}) };
    const [m] = await ctx.db.update(mandates).set(patch).where(and(eq(mandates.id, id), eq(mandates.merchantId, merchant.id))).returning();
    if (!m) throw new AppError('NOT_FOUND', `Mandate ${id} not found`);
    return m;
  });

  /**
   * Move every mandate that lists PSP `from` to PSP `to` (e.g. after migrating to a new connection).
   * A mandate whose list would then mix a non-portable PSP with others is pointed at `to` alone.
   */
  app.post('/v1/mandates/move-psp', async (req) => {
    const merchant = merchantOf(req);
    const { from, to } = movePspBody.parse(req.body);
    const available = new Map((await ctx.psps.requireForMerchant(merchant.id)).map((a) => [a.id, a]));
    resolveEligiblePsps(available, [to]); // `to` must be one of this merchant's routable PSPs
    const affected = await ctx.db
      .select()
      .from(mandates)
      .where(and(eq(mandates.merchantId, merchant.id), sql`${mandates.eligiblePsps} @> ${JSON.stringify([from])}::jsonb`));
    for (const m of affected) {
      const replaced = [...new Set(m.eligiblePsps.map((p) => (p === from ? to : p)))].filter((p) => available.has(p));
      let next: string[];
      try {
        next = resolveEligiblePsps(available, replaced);
      } catch {
        next = [to];
      }
      await ctx.db.update(mandates).set({ eligiblePsps: next }).where(eq(mandates.id, m.id));
    }
    return { moved: affected.length };
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
    const q = listDebitsQuery.parse(req.query);
    const rows = await ctx.db
      .select()
      .from(debits)
      .where(and(eq(debits.merchantId, merchant.id), q.state ? eq(debits.state, q.state) : undefined))
      .orderBy(desc(debits.createdAt))
      .limit(q.limit);
    return { data: rows.map(debitView) };
  });
};
