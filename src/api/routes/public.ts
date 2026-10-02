import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { payments } from '../../db/schema.js';
import { verifyCustomerToken } from '../../payments/customer-token.js';
import type { CustomerDebit } from '../../psp/types.js';
import { customerStatus } from '../../tracking/derive.js';

const TOKEN_HEADER = 'x-payment-token';

function corsHeaders(reply: FastifyReply) {
  reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, OPTIONS')
    .header('access-control-allow-headers', TOKEN_HEADER)
    .header('cache-control', 'no-store');
}

/**
 * Customer-facing payment status for checkout pages. Reads only the canonical state the
 * backend poller maintains — it never calls a PSP, and returns a deliberately small payload.
 */
export const publicRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.options('/public/payments/:id/status', async (_req, reply) => {
    corsHeaders(reply);
    return reply.status(204).send();
  });

  app.get('/public/payments/:id/status', async (req, reply) => {
    corsHeaders(reply);
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const { token: queryToken } = z.object({ token: z.string().max(200).optional() }).parse(req.query);
    const header = req.headers[TOKEN_HEADER];
    const token = typeof header === 'string' ? header : queryToken;
    const notFound = () => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });

    // Same response for an unknown payment and a wrong token, so ids can't be probed.
    if (!token || !verifyCustomerToken(ctx.customerTokenSecret, id, token)) return notFound();
    const [p] = await ctx.db.select({ merchantId: payments.merchantId }).from(payments).where(eq(payments.id, id));
    if (!p) return notFound();

    const row = await ctx.queries.rowFor(p.merchantId, 'COLLECT', id);
    const s = customerStatus(row.merchantStatus, row.customerDebit as CustomerDebit);
    return { paymentId: row.id, status: s.status, message: s.message, amountPaise: row.amountPaise, updatedAt: row.lastUpdatedAt };
  });
};
