import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { merchants, vendors } from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { newId } from '../../ids.js';
import { DEFAULT_STEERING } from '../../rules/steering.js';
import { userView } from '../../auth/users.js';
import { hashApiKey, merchantOf, requireAdmin, type Merchant } from '../app.js';
import { createUserBody } from '../dashboard/plugin.js';
import { createMerchant, createVendor } from '../schemas.js';

export function merchantView(m: Merchant) {
  return {
    id: m.id,
    name: m.name,
    webhookUrl: m.webhookUrl,
    category: m.category,
    smallMerchant: m.smallMerchant,
    methodCosts: m.methodCosts,
    steering: m.steering,
    createdAt: m.createdAt,
  };
}

export const merchantRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  /** Onboard a merchant (admin). The API key and webhook secret are returned exactly once. */
  app.post('/v1/merchants', async (req, reply) => {
    requireAdmin(ctx, req);
    const body = createMerchant.parse(req.body);
    const apiKey = `sk_live_${randomBytes(24).toString('base64url')}`;
    const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [m] = await ctx.db
      .insert(merchants)
      .values({
        id: newId('mer'),
        name: body.name,
        apiKeyHash: hashApiKey(apiKey),
        webhookUrl: body.webhookUrl ?? null,
        webhookSecret,
        category: body.category,
        smallMerchant: body.smallMerchant,
        methodCosts: body.methodCosts,
        steering: { ...DEFAULT_STEERING, ...body.steering },
        createdAt: ctx.clock.now(),
      })
      .returning();
    return reply.status(201).send({ merchant: merchantView(m!), apiKey, webhookSecret });
  });

  app.get('/v1/merchants/me', async (req) => merchantView(merchantOf(req)));

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
