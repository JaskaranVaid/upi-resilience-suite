import { createHash } from 'node:crypto';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';

/** Requests per minute per caller, by route group. */
export interface RateLimits {
  /** Per merchant API key on /v1. */
  apiPerMinute: number;
  /** Per client IP on the dashboard login (password guessing). */
  loginPerMinute: number;
  /** Per client IP on customer-facing /public routes. */
  publicPerMinute: number;
  /** Per signed-in session (or IP) on the rest of the dashboard API. */
  dashboardPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  apiPerMinute: 1200,
  loginPerMinute: 20,
  publicPerMinute: 300,
  dashboardPerMinute: 600,
};

type Group = keyof RateLimits | null;

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

function groupOf(req: FastifyRequest): Group {
  const url = req.routeOptions.url ?? req.url;
  if (url.startsWith('/v1/')) return 'apiPerMinute';
  if (url === '/dashboard/api/login') return 'loginPerMinute';
  if (url.startsWith('/dashboard/api/')) return 'dashboardPerMinute';
  if (url.startsWith('/public/')) return 'publicPerMinute';
  return null; // health checks, static dashboard assets and PSP webhooks are not limited here
}

/** Who is calling: the API key or session (hashed — raw secrets never sit in the counter store), else the IP. */
function callerOf(req: FastifyRequest, group: Group): string {
  if (group === 'apiPerMinute') {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return `key:${sha(auth.slice(7).trim())}`;
  }
  if (group === 'dashboardPerMinute') {
    const session = req.cookies?.rs_session;
    if (session) return `ses:${sha(session)}`;
  }
  return `ip:${req.ip}`;
}

/**
 * Per-caller request limits, registered on the root instance so they cover every route.
 * In-process counters; a shared store arrives with multi-instance deploys.
 */
export function registerRateLimits(app: FastifyInstance, limits: RateLimits): void {
  app.register(fastifyRateLimit, {
    global: true,
    timeWindow: 60_000,
    keyGenerator: (req) => {
      const group = groupOf(req);
      return `${group ?? 'none'}|${callerOf(req, group)}`;
    },
    allowList: (req) => groupOf(req) === null,
    max: (req) => {
      const group = groupOf(req);
      return group ? limits[group] : Number.MAX_SAFE_INTEGER;
    },
    errorResponseBuilder: (_req, ctx) => new AppError('RATE_LIMITED', `Too many requests — try again in ${ctx.after}`),
  });
}
