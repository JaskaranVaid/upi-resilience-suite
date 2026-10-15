import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';

/**
 * Inbound PSP webhooks. Signature verification needs the exact raw body, so this plugin parses
 * JSON as a string (scoped to these routes only). A verified webhook only schedules re-checks.
 */
export const pspWebhookRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/webhooks/psp/:pspId', async (req, reply) => {
    const { pspId } = z.object({ pspId: z.string().min(1).max(50) }).parse(req.params);
    let adapter;
    try {
      adapter = await ctx.psps.get(pspId);
    } catch {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown payment provider' } });
    }
    if (!adapter.verifyWebhook) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'This payment provider does not send webhooks' } });
    }
    const raw = typeof req.body === 'string' ? req.body : '';
    const verified = adapter.verifyWebhook(raw, req.headers, ctx.clock.now());
    if (!verified.ok) {
      req.log.warn({ pspId, reason: verified.reason }, 'rejected PSP webhook');
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' } });
    }
    const { matched } = await ctx.webhookIngest.recheck(pspId, verified.refs);
    // Always 200 for a genuine webhook, even if it concerns nothing we track (avoids retry storms).
    return { received: true, matched };
  });
};
