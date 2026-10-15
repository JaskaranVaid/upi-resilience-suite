import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { apiKeyView } from '../../auth/api-keys.js';
import { merchants, pspConnections } from '../../db/schema.js';
import { listDeliveriesQuery } from '../routes/webhook-deliveries.js';
import { idParam } from '../schemas.js';
import { requireRole, userOf } from './plugin.js';

/** Developers page (admins): integration settings, API keys, PSP connections and the webhook log. */
export const developerRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  const admin = (req: Parameters<typeof userOf>[0]) => requireRole(req, ['ADMIN']).merchantId;

  app.get('/dashboard/api/developers', async (req) => {
    const merchantId = admin(req);
    const [m] = await ctx.db.select({ mode: merchants.mode, webhookUrl: merchants.webhookUrl }).from(merchants).where(eq(merchants.id, merchantId));
    return { mode: m!.mode, webhookUrl: m!.webhookUrl, apiBase: ctx.publicBaseUrl ?? '', docsPath: '/docs', openapiPath: '/openapi.json' };
  });

  app.get('/dashboard/api/developers/api-keys', async (req) => ({ data: (await ctx.apiKeys.list(admin(req))).map(apiKeyView) }));

  app.get('/dashboard/api/developers/psp-connections', async (req) => {
    const rows = await ctx.db.select().from(pspConnections).where(eq(pspConnections.merchantId, admin(req))).orderBy(asc(pspConnections.priority));
    return {
      data: rows.map((c) => ({ id: c.id, provider: c.provider, label: c.label, environment: c.environment, status: c.status, priority: c.priority, credentialHint: c.publicHint, createdAt: c.createdAt })),
    };
  });

  app.get('/dashboard/api/developers/webhook-deliveries', async (req) => ctx.webhookDeliveries.list(admin(req), listDeliveriesQuery.parse(req.query)));

  app.post('/dashboard/api/developers/webhook-deliveries/:id/redeliver', async (req, reply) => {
    const merchantId = admin(req);
    const { id } = idParam.parse(req.params);
    return reply.status(202).send(await ctx.webhookDeliveries.redeliver(merchantId, id));
  });
};
