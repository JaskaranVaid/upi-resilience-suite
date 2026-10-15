import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { pspConnections, type MerchantMode } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { looksLikePlaceholder } from '../../psp/factory.js';
import { ENVIRONMENT_FOR_MODE, type ConnectionRow } from '../../psp/registry.js';
import { merchantOf } from '../app.js';
import { idParam } from '../schemas.js';

const cashfreeCredentials = z.object({ clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(500) }).strict();
const razorpayCredentials = z
  .object({ keyId: z.string().regex(/^rzp_(test|live)_\w+$/, 'expected a Razorpay key id (rzp_test_… or rzp_live_…)'), keySecret: z.string().min(1).max(500), webhookSecret: z.string().min(1).max(500).optional() })
  .strict();
const anyCredentials = z.record(z.string(), z.string());

export const createConnectionBody = z.object({
  provider: z.enum(['cashfree', 'razorpay', 'mock']),
  label: z.string().min(1).max(100).optional(),
  /** Defaults to the merchant's mode: sandbox for TEST merchants, production for LIVE ones. */
  environment: z.enum(['sandbox', 'production']).optional(),
  credentials: anyCredentials.optional(),
  /** Lower goes first among the merchant's connections. */
  priority: z.number().int().min(0).max(1000).optional(),
});

export const updateConnectionBody = z
  .object({
    label: z.string().min(1).max(100).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    credentials: anyCredentials.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const hint = (clientId: string) => (clientId.length <= 8 ? '••••' : `${clientId.slice(0, 4)}…${clientId.slice(-4)}`);

/**
 * A merchant's own PSP accounts (ADR 0002). Credentials are checked against the PSP before they
 * are saved, sealed at rest, and never returned.
 */
export const connectionRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  const view = (c: ConnectionRow) => ({
    id: c.id,
    provider: c.provider,
    label: c.label,
    environment: c.environment,
    status: c.status,
    priority: c.priority,
    credentialHint: c.publicHint,
    /** Configure this URL for payment, refund and subscription webhooks in the PSP's dashboard. */
    webhookUrl: `${ctx.publicBaseUrl ?? ''}/webhooks/psp/${c.id}`,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });

  /** Build the adapter from a draft row and make sure the PSP accepts the credentials. */
  async function verify(row: ConnectionRow, credentials: Record<string, string> | null) {
    const adapter = ctx.connectionAdapters(row, credentials);
    if (!adapter.checkCredentials) return;
    const check = await adapter.checkCredentials();
    if (!check.ok) throw new AppError(check.rejected ? 'PSP_CREDENTIALS_REJECTED' : 'PSP_UNREACHABLE', check.reason);
  }

  /** Validated credentials for the provider (never echoed back in errors). */
  function credentialsFor(provider: ConnectionRow['provider'], environment: ConnectionRow['environment'], credentials: Record<string, string> | undefined) {
    if (provider === 'mock') {
      if (credentials) throw new AppError('VALIDATION', 'Mock connections take no credentials');
      return null;
    }
    if (!credentials) {
      throw new AppError('VALIDATION', provider === 'cashfree' ? 'credentials { clientId, clientSecret } are required for Cashfree' : 'credentials { keyId, keySecret, webhookSecret? } are required for Razorpay');
    }
    const parsed = (provider === 'cashfree' ? cashfreeCredentials : razorpayCredentials).safeParse(credentials);
    if (!parsed.success) throw new AppError('VALIDATION', `credentials: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'object'} ${i.message}`).join('; ')}`);
    const valid = parsed.data as Record<string, string>;
    for (const [name, value] of Object.entries(valid)) {
      if (looksLikePlaceholder(value)) throw new AppError('VALIDATION', `credentials.${name} looks like a placeholder, not a real key`);
    }
    if (provider === 'razorpay' && valid.keyId!.startsWith('rzp_live_') !== (environment === 'production')) {
      throw new AppError('VALIDATION', environment === 'production' ? 'A live merchant needs rzp_live_ keys' : 'A test-mode merchant needs rzp_test_ keys');
    }
    return valid;
  }

  const hintFor = (c: Record<string, string>) => hint(c.clientId ?? c.keyId ?? '');

  function checkEnvironment(mode: MerchantMode, provider: ConnectionRow['provider'], environment: ConnectionRow['environment']) {
    if (environment !== ENVIRONMENT_FOR_MODE[mode]) {
      throw new AppError(
        'VALIDATION',
        mode === 'TEST' ? 'A test-mode merchant can only connect sandbox accounts' : 'A live merchant can only connect production accounts',
      );
    }
    if (provider === 'mock' && mode === 'LIVE') throw new AppError('VALIDATION', 'Mock connections are for test-mode merchants only');
  }

  app.post('/v1/psp-connections', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createConnectionBody.parse(req.body);
    const environment = body.environment ?? ENVIRONMENT_FOR_MODE[merchant.mode];
    checkEnvironment(merchant.mode, body.provider, environment);
    const credentials = credentialsFor(body.provider, environment, body.credentials);
    const now = ctx.clock.now();
    const row: ConnectionRow = {
      id: newId('con'),
      merchantId: merchant.id,
      provider: body.provider,
      label: body.label ?? (body.provider === 'mock' ? 'Mock PSP (test mode)' : `${body.provider === 'cashfree' ? 'Cashfree' : 'Razorpay'} (${environment})`),
      environment,
      status: 'ACTIVE',
      priority: body.priority ?? 100,
      credentialsSealed: credentials ? ctx.secrets.seal(credentials) : null,
      publicHint: credentials ? hintFor(credentials) : null,
      createdAt: now,
      updatedAt: now,
    };
    await verify(row, credentials);
    const [saved] = await ctx.db.insert(pspConnections).values(row).returning();
    return reply.status(201).send(view(saved!));
  });

  app.get('/v1/psp-connections', async (req) => {
    const rows = await ctx.db
      .select()
      .from(pspConnections)
      .where(eq(pspConnections.merchantId, merchantOf(req).id))
      .orderBy(asc(pspConnections.priority), asc(pspConnections.createdAt));
    return { data: rows.map(view) };
  });

  app.patch('/v1/psp-connections/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    const body = updateConnectionBody.parse(req.body);
    const [current] = await ctx.db.select().from(pspConnections).where(and(eq(pspConnections.id, id), eq(pspConnections.merchantId, merchant.id)));
    if (!current) throw new AppError('NOT_FOUND', `Connection ${id} not found`);
    const patch: Partial<ConnectionRow> = { updatedAt: ctx.clock.now() };
    if (body.label !== undefined) patch.label = body.label;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.status !== undefined) patch.status = body.status;
    if (body.credentials) {
      const credentials = credentialsFor(current.provider, current.environment, body.credentials);
      await verify({ ...current, ...patch }, credentials);
      patch.credentialsSealed = ctx.secrets.seal(credentials);
      patch.publicHint = credentials ? hintFor(credentials) : null;
    }
    const [updated] = await ctx.db.update(pspConnections).set(patch).where(eq(pspConnections.id, id)).returning();
    ctx.psps.invalidate(id);
    return view(updated!);
  });
};
