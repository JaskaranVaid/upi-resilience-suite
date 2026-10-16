import { asc, desc, eq, ilike } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { executionPauses, merchants } from '../db/schema.js';
import { AppError } from '../errors.js';
import { collectOpsMetrics } from '../ops/metrics.js';
import { operatorView } from '../ops-console/operators.js';
import { pauseView } from '../ops-console/pauses.js';
import { CAN_ACT, operatorOf, requireOperatorRole } from './ops-auth.js';
import { opsPilotsApi } from './ops-pilots.js';
import { erasureFields, needsIdentifier } from './routes/privacy.js';

export const OPS_COOKIE = 'mf_ops';
export const OPS_CSRF_HEADER = 'x-ops-request';
export const MIN_OPERATOR_PASSWORD = 14;


const loginBody = z.object({ email: z.string().min(3).max(320), password: z.string().min(1).max(1024), code: z.string().max(20) });
const passwordBody = z.object({ current: z.string().min(1).max(1024), next: z.string().min(MIN_OPERATOR_PASSWORD, `at least ${MIN_OPERATOR_PASSWORD} characters`).max(1024) });
const opsErasureBody = z
  .object({ merchantId: z.string().min(1).max(100), reason: z.string().min(1).max(500), ...erasureFields })
  .strict()
  .refine(needsIdentifier, 'give vpa, phone or both');
const pauseBody = z.object({ scope: z.enum(['GLOBAL', 'MERCHANT', 'PSP']), target: z.string().max(200).optional(), reason: z.string().min(1).max(500) });

/**
 * Ops console API for Merchantflo staff (/ops/api, cookie session). Same defences as the merchant
 * dashboard — SameSite=Strict cookie scoped to /ops, a custom header on every state change, the
 * failed-authentication limiter — plus a TOTP code at every sign-in.
 */
export const opsConsoleApi = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.decorateRequest('operator', null);

  app.addHook('preHandler', async (req) => {
    if (req.method !== 'GET' && req.headers[OPS_CSRF_HEADER] !== '1') throw new AppError('FORBIDDEN', `Missing ${OPS_CSRF_HEADER} header`);
    if (req.routeOptions.url === '/ops/api/login') return;
    const token = req.cookies[OPS_COOKIE];
    if (token) ctx.authFailures?.assertAllowed(req.ip);
    req.operator = await ctx.operators.authenticate(token);
    if (!req.operator) {
      if (token) ctx.authFailures?.recordFailure(req.ip);
      throw new AppError('UNAUTHORIZED', 'Please sign in');
    }
  });

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(OPS_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.secureCookies,
      path: '/ops',
      maxAge: Math.floor(ctx.operators.config.absoluteTimeoutMs / 1000),
    });

  app.post('/ops/api/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    ctx.authFailures?.assertAllowed(req.ip);
    try {
      const { operator, token } = await ctx.operators.login(body.email, body.password, body.code);
      setCookie(reply, token);
      return { operator: operatorView(operator) };
    } catch (e) {
      if (e instanceof AppError && e.code === 'UNAUTHORIZED') ctx.authFailures?.recordFailure(req.ip);
      throw e;
    }
  });

  app.post('/ops/api/logout', async (req, reply) => {
    await ctx.operators.logout(req.cookies[OPS_COOKIE]);
    reply.clearCookie(OPS_COOKIE, { path: '/ops' });
    return { ok: true };
  });

  app.get('/ops/api/me', async (req) => ({ operator: operatorView(operatorOf(req)) }));

  app.post('/ops/api/me/password', async (req) => {
    const o = operatorOf(req);
    const body = passwordBody.parse(req.body);
    await ctx.operators.changePassword(o.id, body.current, body.next, req.cookies[OPS_COOKIE]);
    return { ok: true };
  });

  app.get('/ops/api/metrics', async () => collectOpsMetrics({ db: ctx.db, clock: ctx.clock, health: ctx.health }));

  app.get('/ops/api/audit', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return { data: await ctx.operators.listAudit(limit) };
  });

  app.get('/ops/api/merchants', async (req) => {
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    const rows = await ctx.db
      .select({ id: merchants.id, name: merchants.name, mode: merchants.mode })
      .from(merchants)
      .where(q ? ilike(merchants.name, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) : undefined)
      .orderBy(asc(merchants.name))
      .limit(50);
    return { data: rows };
  });

  app.get('/ops/api/pauses', async (req) => {
    const { include } = z.object({ include: z.enum(['active', 'recent']).default('active') }).parse(req.query);
    const rows =
      include === 'active'
        ? await ctx.pauses.active()
        : await ctx.db.select().from(executionPauses).orderBy(desc(executionPauses.createdAt)).limit(50);
    return { data: rows.map(pauseView) };
  });

  app.post('/ops/api/pauses', async (req, reply) => {
    const o = requireOperatorRole(req, CAN_ACT);
    const body = pauseBody.parse(req.body);
    const p = await ctx.pauses.pause(body, o.id);
    return reply.status(201).send(pauseView(p));
  });

  app.post('/ops/api/privacy/erasure', async (req) => {
    const o = requireOperatorRole(req, CAN_ACT);
    const { merchantId, reason, ...who } = opsErasureBody.parse(req.body);
    const [m] = await ctx.db.select({ id: merchants.id }).from(merchants).where(eq(merchants.id, merchantId));
    if (!m) throw new AppError('NOT_FOUND', `Merchant ${merchantId} not found`);
    const counts = await ctx.privacy.erase(merchantId, who, { type: 'SYSTEM' });
    await ctx.operators.audit(ctx.db, o.id, 'DATA_ERASED', merchantId, { reason, ...counts });
    return counts;
  });

  app.post('/ops/api/pauses/:id/lift', async (req) => {
    const o = requireOperatorRole(req, CAN_ACT);
    const { id } = z.object({ id: z.string().max(100) }).parse(req.params);
    return pauseView(await ctx.pauses.lift(id, o.id));
  });

  // Child plugin: inherits the session and CSRF hook above.
  await app.register(opsPilotsApi(ctx));
};
