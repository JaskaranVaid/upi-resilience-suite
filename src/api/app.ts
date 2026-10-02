import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import { merchants } from '../db/schema.js';
import { AppError } from '../errors.js';
import { checkoutRoutes } from './routes/checkout.js';
import { mandateRoutes } from './routes/mandates.js';
import { merchantRoutes } from './routes/merchants.js';
import { opsRoutes } from './routes/ops.js';
import { paymentRoutes } from './routes/payments.js';

export type Merchant = typeof merchants.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    merchant: Merchant | null;
  }
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** The authenticated merchant; route handlers under /v1 can rely on it being set. */
export function merchantOf(req: FastifyRequest): Merchant {
  if (!req.merchant) throw new AppError('UNAUTHORIZED', 'Missing or invalid API key');
  return req.merchant;
}

export function requireAdmin(ctx: AppContext, req: FastifyRequest): void {
  const token = bearer(req) ?? '';
  const a = Buffer.from(token);
  const b = Buffer.from(ctx.adminToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('UNAUTHORIZED', 'Admin token required');
}

export function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.decorateRequest('merchant', null);
  app.addHook('preHandler', async (req) => {
    const route = req.routeOptions.url ?? '';
    // Merchant onboarding uses the admin token instead of a merchant API key.
    if (!route.startsWith('/v1/') || (route === '/v1/merchants' && req.method === 'POST')) return;
    const key = bearer(req);
    if (!key) throw new AppError('UNAUTHORIZED', 'Missing API key');
    const [m] = await ctx.db.select().from(merchants).where(eq(merchants.apiKeyHash, hashApiKey(key)));
    if (!m) throw new AppError('UNAUTHORIZED', 'Invalid API key');
    req.merchant = m;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') },
      });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'VALIDATION', message: e.message ?? 'Bad request' } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
  });

  app.register(opsRoutes(ctx));
  app.register(merchantRoutes(ctx));
  app.register(mandateRoutes(ctx));
  app.register(checkoutRoutes(ctx));
  app.register(paymentRoutes(ctx));
  return app;
}
