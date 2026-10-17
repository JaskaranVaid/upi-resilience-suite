import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { merchants, vendors } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { DEFAULT_STEERING } from '../../rules/steering.js';
import { checkWebhookUrl } from '../../webhooks/url.js';
import { startShadowOnFirstLive } from '../../pilot/rollout.js';
import { userView } from '../../auth/users.js';
import { merchantOf, requireAdmin, type Merchant } from '../app.js';
import { apiKeyView } from '../../auth/api-keys.js';
import { createUserBody } from '../dashboard/plugin.js';
import { createMerchant, createVendor, idParam, updateMerchant } from '../schemas.js';

export function merchantView(m: Merchant) {
  return {
    id: m.id,
    name: m.name,
    mode: m.mode,
    webhookUrl: m.webhookUrl,
    category: m.category,
    smallMerchant: m.smallMerchant,
    methodCosts: m.methodCosts,
    steering: m.steering,
    /** Pilot rollout: who executes AutoPay debits (see GET /v1/pilot). */
    rolloutStage: m.rolloutStage,
    canaryPercent: m.canaryPercent,
    createdAt: m.createdAt,
  };
}

export const createApiKeyBody = z.object({ label: z.string().min(1).max(100).optional() });
export const changeModeBody = z.object({ mode: z.enum(['TEST', 'LIVE']) }).strict();

export const merchantRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  /** Onboard a merchant (admin). The API key and webhook secret are returned exactly once. */
  app.post('/v1/merchants', async (req, reply) => {
    requireAdmin(ctx, req);
    const body = createMerchant.parse(req.body);
    const urlProblem = body.webhookUrl ? checkWebhookUrl(body.webhookUrl, ctx.webhookTargets) : null;
    if (urlProblem) throw new AppError('VALIDATION', `webhookUrl ${urlProblem}`);
    const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    const { m, apiKey } = await ctx.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(merchants)
        .values({
          id: newId('mer'),
          name: body.name,
          mode: body.mode,
          webhookUrl: body.webhookUrl ?? null,
          webhookSecret,
          category: body.category,
          smallMerchant: body.smallMerchant,
          methodCosts: body.methodCosts,
          steering: { ...DEFAULT_STEERING, ...body.steering },
          createdAt: ctx.clock.now(),
        })
        .returning();
      const { key } = await ctx.apiKeys.issue(tx, m!.id, m!.mode, 'Initial key');
      return { m: await startShadowOnFirstLive(tx, ctx.operators, m!, ctx.clock.now()), apiKey: key };
    });
    return reply.status(201).send({ merchant: merchantView(m), apiKey, webhookSecret });
  });

  /** A new API key for the calling merchant (rotation: create, deploy, then revoke the old one). */
  app.post('/v1/api-keys', async (req, reply) => {
    const merchant = merchantOf(req);
    const { label } = createApiKeyBody.parse(req.body ?? {});
    const { key, row } = await ctx.apiKeys.issue(ctx.db, merchant.id, merchant.mode, label ?? null);
    return reply.status(201).send({ ...apiKeyView(row), key });
  });

  app.get('/v1/api-keys', async (req) => ({ data: (await ctx.apiKeys.list(merchantOf(req).id)).map(apiKeyView) }));

  app.post('/v1/api-keys/:id/revoke', async (req) => {
    const { id } = idParam.parse(req.params);
    return apiKeyView(await ctx.apiKeys.revoke(merchantOf(req).id, id));
  });

  app.get('/v1/merchants/me', async (req) => merchantView(merchantOf(req)));

  /**
   * Operator action (admin token): change a merchant's mode, e.g. a deployment that predates test
   * and live modes. Every existing key is revoked and one new key with the matching prefix is
   * returned once. The merchant then points its mandates at connections valid for the new mode.
   */
  app.patch('/v1/admin/merchants/:id', async (req) => {
    requireAdmin(ctx, req);
    const { id } = idParam.parse(req.params);
    const { mode } = changeModeBody.parse(req.body);
    return ctx.db.transaction(async (tx) => {
      const [current] = await tx.select().from(merchants).where(eq(merchants.id, id)).for('update');
      if (!current) throw new AppError('NOT_FOUND', `Merchant ${id} not found`);
      if (current.mode === mode) throw new AppError('CONFLICT', `Merchant is already ${mode}`);
      const [updated] = await tx.update(merchants).set({ mode }).where(eq(merchants.id, id)).returning();
      const m = await startShadowOnFirstLive(tx, ctx.operators, updated!, ctx.clock.now());
      const apiKey = await ctx.apiKeys.replaceAll(tx, id, mode);
      return { merchant: merchantView(m), apiKey };
    });
  });

  app.patch('/v1/merchants/me', async (req) => {
    const merchant = merchantOf(req);
    const body = updateMerchant.parse(req.body);
    if (body.webhookUrl) {
      const problem = checkWebhookUrl(body.webhookUrl, ctx.webhookTargets);
      if (problem) throw new AppError('VALIDATION', `webhookUrl ${problem}`);
    }
    const { steering, ...rest } = body;
    const [m] = await ctx.db
      .update(merchants)
      .set({ ...rest, ...(steering ? { steering: { ...merchant.steering, ...steering } } : {}) })
      .where(eq(merchants.id, merchant.id))
      .returning();
    return merchantView(m!);
  });

  /** New webhook signing secret, returned once. Deliveries from now on are signed with it. */
  app.post('/v1/merchants/me/webhook-secret/rotate', async (req) => {
    const merchant = merchantOf(req);
    const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    await ctx.db.update(merchants).set({ webhookSecret }).where(eq(merchants.id, merchant.id));
    return { webhookSecret };
  });

  app.post('/v1/vendors', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createVendor.parse(req.body);
    try {
      const [v] = await ctx.db
        .insert(vendors)
        .values({ id: newId('ven'), merchantId: merchant.id, ...body, createdAt: ctx.clock.now() })
        .returning();
      return reply.status(201).send(v);
    } catch {
      throw new AppError('CONFLICT', `Vendor ${body.externalId} already exists`);
    }
  });

  /**
   * Create a dashboard user with the merchant API key — how the first admin is bootstrapped.
   * After that, admins manage users from the dashboard.
   */
  app.post('/v1/dashboard-users', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createUserBody.parse(req.body);
    const user = await ctx.users.create(merchant.id, body, { type: 'API_KEY', id: merchant.id });
    return reply.status(201).send(userView(user));
  });

  app.get('/v1/vendors', async (req) => {
    const merchant = merchantOf(req);
    return { data: await ctx.db.select().from(vendors).where(eq(vendors.merchantId, merchant.id)) };
  });
};
