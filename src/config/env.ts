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
  /** Comma-separated mock PSP ids. Replace with real adapters when integrating gateways. */
  MOCK_PSPS: z.string().default('pspA,pspB'),
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
