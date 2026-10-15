import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { merchants, type DashboardRole } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../../events/record.js';
import { userView, type DashboardUser } from '../../auth/users.js';
import { analyticsRoutes } from './analytics.js';
import { dashboardDataRoutes } from './data.js';
import { developerRoutes } from './developers.js';

export const SESSION_COOKIE = 'rs_session';
export const CSRF_HEADER = 'x-dashboard-request';

declare module 'fastify' {
  interface FastifyRequest {
    dashboardUser: DashboardUser | null;
  }
}

export function userOf(req: FastifyRequest): DashboardUser {
  if (!req.dashboardUser) throw new AppError('UNAUTHORIZED', 'Please sign in');
  return req.dashboardUser;
}

export function actorOf(req: FastifyRequest): Actor & { type: 'DASHBOARD_USER' } {
  return { type: 'DASHBOARD_USER', id: userOf(req).id };
}

/** Throws FORBIDDEN unless the signed-in user has one of the roles. */
export function requireRole(req: FastifyRequest, roles: DashboardRole[]): DashboardUser {
  const u = userOf(req);
  if (!roles.includes(u.role)) throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  return u;
}

export const OPERATOR_ROLES: DashboardRole[] = ['ADMIN', 'SUPPORT'];

const loginBody = z.object({ email: z.string().min(3).max(320), password: z.string().min(1).max(1024) });
const roleEnum = z.enum(['ADMIN', 'SUPPORT', 'VIEWER']);
export const createUserBody = z.object({
  email: z.email().max(320),
  name: z.string().min(1).max(200),
  password: z.string().min(12).max(1024),
  role: roleEnum,
});
const updateUserBody = z
  .object({ role: roleEnum.optional(), disabled: z.boolean().optional(), name: z.string().min(1).max(200).optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

/**
 * Merchant dashboard API (cookie session). Every route here requires a signed-in user except
 * login; every state-changing request requires the X-Dashboard-Request header, which a
 * cross-site form or image cannot send (SameSite=Strict is the first line of defence).
 */
export const dashboardApi = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.decorateRequest('dashboardUser', null);

  app.addHook('preHandler', async (req) => {
    if (req.method !== 'GET' && req.headers[CSRF_HEADER] !== '1') {
      throw new AppError('FORBIDDEN', `Missing ${CSRF_HEADER} header`);
    }
    if (req.routeOptions.url === '/dashboard/api/login') return;
    const token = req.cookies[SESSION_COOKIE];
    // A presented-but-invalid session counts against the IP, so made-up cookies can't be farmed.
    if (token) ctx.authFailures?.assertAllowed(req.ip);
    req.dashboardUser = await ctx.sessions.authenticate(token);
    if (!req.dashboardUser) {
      if (token) ctx.authFailures?.recordFailure(req.ip);
      throw new AppError('UNAUTHORIZED', 'Please sign in');
    }
    // Merchant isolation is enforced by every query using the user's merchant id.
  });

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.secureCookies,
      path: '/',
      maxAge: Math.floor(ctx.sessions.config.absoluteTimeoutMs / 1000),
    });

  app.post('/dashboard/api/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const { user, token } = await ctx.sessions.login(body.email, body.password);
    setCookie(reply, token);
    return { user: userView(user) };
  });

  app.post('/dashboard/api/logout', async (req, reply) => {
    await ctx.sessions.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/dashboard/api/me', async (req) => {
    const u = userOf(req);
    const [m] = await ctx.db.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, u.merchantId));
    return { user: userView(u), merchant: { id: u.merchantId, name: m?.name ?? '' } };
  });

  app.get('/dashboard/api/users', async (req) => {
    const u = requireRole(req, ['ADMIN']);
    return { data: (await ctx.users.list(u.merchantId)).map(userView) };
  });

  app.post('/dashboard/api/users', async (req, reply) => {
    const u = requireRole(req, ['ADMIN']);
    const body = createUserBody.parse(req.body);
    const created = await ctx.users.create(u.merchantId, body, actorOf(req));
    return reply.status(201).send(userView(created));
  });

  app.patch('/dashboard/api/users/:id', async (req) => {
    const u = requireRole(req, ['ADMIN']);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const patch = updateUserBody.parse(req.body);
    return userView(await ctx.users.update(u.merchantId, id, patch, actorOf(req)));
  });

  await app.register(dashboardDataRoutes(ctx));
  await app.register(analyticsRoutes(ctx));
  await app.register(developerRoutes(ctx));
};
