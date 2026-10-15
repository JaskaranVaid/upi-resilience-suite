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

const cashfreeCredentials = z.object({ clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(500) });

const createBody = z.object({
  provider: z.enum(['cashfree', 'mock']),
  label: z.string().min(1).max(100).optional(),
  /** Defaults to the merchant's mode: sandbox for TEST merchants, production for LIVE ones. */
  environment: z.enum(['sandbox', 'production']).optional(),
  credentials: cashfreeCredentials.optional(),
  /** Lower goes first among the merchant's connections. */
  priority: z.number().int().min(0).max(1000).optional(),
});

const updateBody = z
  .object({
    label: z.string().min(1).max(100).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    credentials: cashfreeCredentials.optional(),
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

  function credentialsFor(provider: ConnectionRow['provider'], credentials: z.infer<typeof cashfreeCredentials> | undefined) {
    if (provider === 'mock') {
      if (credentials) throw new AppError('VALIDATION', 'Mock connections take no credentials');
      return null;
    }
    if (!credentials) throw new AppError('VALIDATION', 'credentials { clientId, clientSecret } are required for Cashfree');
    for (const [name, value] of Object.entries(credentials)) {
      if (looksLikePlaceholder(value)) throw new AppError('VALIDATION', `credentials.${name} looks like a placeholder, not a real key`);
    }
    return credentials;
  }

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
    const body = createBody.parse(req.body);
    const environment = body.environment ?? ENVIRONMENT_FOR_MODE[merchant.mode];
    checkEnvironment(merchant.mode, body.provider, environment);
    const credentials = credentialsFor(body.provider, body.credentials);
    const now = ctx.clock.now();
    const row: ConnectionRow = {
      id: newId('con'),
      merchantId: merchant.id,
      provider: body.provider,
      label: body.label ?? (body.provider === 'cashfree' ? `Cashfree (${environment})` : 'Mock PSP (test mode)'),
      environment,
      status: 'ACTIVE',
      priority: body.priority ?? 100,
      credentialsSealed: credentials ? ctx.secrets.seal(credentials) : null,
      publicHint: credentials ? hint(credentials.clientId) : null,
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
    const body = updateBody.parse(req.body);
    const [current] = await ctx.db.select().from(pspConnections).where(and(eq(pspConnections.id, id), eq(pspConnections.merchantId, merchant.id)));
    if (!current) throw new AppError('NOT_FOUND', `Connection ${id} not found`);
    const patch: Partial<ConnectionRow> = { updatedAt: ctx.clock.now() };
    if (body.label !== undefined) patch.label = body.label;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.status !== undefined) patch.status = body.status;
    if (body.credentials) {
      const credentials = credentialsFor(current.provider, body.credentials);
      await verify({ ...current, ...patch }, credentials);
      patch.credentialsSealed = ctx.secrets.seal(credentials);
      patch.publicHint = hint(body.credentials.clientId);
    }
    const [updated] = await ctx.db.update(pspConnections).set(patch).where(eq(pspConnections.id, id)).returning();
    ctx.psps.invalidate(id);
    return view(updated!);
  });
};
