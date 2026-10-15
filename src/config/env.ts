import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** postgres://… in production; pglite://<dir> or pglite://memory for local dev. */
  DATABASE_URL: z.string().default('pglite://.data/pg'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  /** api = HTTP only, worker = debit executor + webhook dispatcher only, all = both. */
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  ADMIN_TOKEN: z.string().min(16).optional(),
  /** Signs payment-scoped customer status tokens. Required in production. */
  CUSTOMER_TOKEN_SECRET: z.string().min(32).optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  /**
   * On SIGTERM the api first reports not-ready (/readyz 503) and waits this long so the load
   * balancer stops routing to it, then finishes in-flight requests and exits.
   */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(0),
  /** Exit with an error if a graceful shutdown takes longer than this. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(25_000),
  /** The worker writes the time of each completed tick here; the container health check reads it. */
  HEARTBEAT_FILE: z.string().optional(),
  /** The health check fails when the worker's last completed tick is older than this. */
  WORKER_STALL_MS: z.coerce.number().int().min(10_000).default(600_000),
  /** Comma-separated mock PSP ids (may be empty). Mocks never reach a real PSP. */
  MOCK_PSPS: z.string().default('pspA,pspB'),
  /** Mock PSPs are refused in production unless this is explicitly 'true'. */
  ALLOW_MOCK_PSPS: z.enum(['true', 'false']).default('false'),
  /** Cashfree Payments (real PSP). Set both id and secret to enable. */
  CASHFREE_CLIENT_ID: z.string().min(1).optional(),
  CASHFREE_CLIENT_SECRET: z.string().min(1).optional(),
  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  CASHFREE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /**
   * IST date (YYYY-MM-DD) the UPI MDR regime starts. Unset = not in force: NPCI postponed the
   * announced 15 Oct 2026 start with no new date, so no fee is quoted until this is set.
   */
  MDR_EFFECTIVE_FROM: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  /**
   * Proxies in front of the API, so client IPs (used by rate limits) come from X-Forwarded-For:
   * 'false', a hop count (e.g. 1 behind one load balancer), or comma-separated proxy IPs/CIDRs.
   * 'true' is refused: trusting every hop lets clients choose their own IP.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v, c): false | number | string[] => {
      const s = v.trim();
      if (s === 'false' || s === '') return false;
      if (/^\d+$/.test(s)) return Number(s);
      if (s === 'true') {
        c.addIssue({ code: 'custom', message: 'TRUST_PROXY=true trusts client-supplied X-Forwarded-For; set the number of proxy hops (e.g. 1) or proxy CIDRs' });
        return z.NEVER;
      }
      return s.split(',').map((p) => p.trim()).filter(Boolean);
    }),
  /**
   * Where merchant webhooks may point. Defaults to public-only (https, public hosts) in production
   * and to any http(s) URL elsewhere, so local development can use http://localhost.
   */
  WEBHOOK_TARGETS: z.enum(['public-only', 'any']).optional(),
  /**
   * Key ring encrypting merchants' PSP credentials: "k2:<base64 32 bytes>,k1:<…>" (first = active).
   * Required in production. Generate a key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  CREDENTIALS_KEYS: z.string().optional(),
  /** Public base URL of this API (e.g. https://api.merchantflo.in), used to show PSP webhook URLs. */
  PUBLIC_BASE_URL: z.url().optional(),
  /** Optional JSON map of pspId -> MockRates, e.g. {"pspA":{"bankUnavailable":0.3}} */
  MOCK_PSP_RATES: z.string().optional(),
});

export type Env = z.infer<typeof schema> & { ADMIN_TOKEN: string; CUSTOMER_TOKEN_SECRET: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = schema.parse(source);
  if (!env.ADMIN_TOKEN) {
    if (env.NODE_ENV === 'production') throw new Error('ADMIN_TOKEN is required in production');
    console.warn('ADMIN_TOKEN not set — using insecure development token "dev-admin-token-change-me"');
  }
  if (!env.CUSTOMER_TOKEN_SECRET) {
    if (env.NODE_ENV === 'production') throw new Error('CUSTOMER_TOKEN_SECRET is required in production');
    console.warn('CUSTOMER_TOKEN_SECRET not set — using an insecure development secret');
  }
  return {
    ...env,
    ADMIN_TOKEN: env.ADMIN_TOKEN ?? 'dev-admin-token-change-me',
    CUSTOMER_TOKEN_SECRET: env.CUSTOMER_TOKEN_SECRET ?? 'dev-customer-token-secret-not-for-production',
  };
}
