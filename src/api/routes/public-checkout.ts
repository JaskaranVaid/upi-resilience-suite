import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { verifySessionToken } from '../../checkout/sessions.js';
import { AppError } from '../../errors.js';
import { PAYMENT_METHODS } from '../../rules/steering.js';
import { vpa } from '../schemas.js';

const TOKEN_HEADER = 'x-checkout-token';

const payBody = z
  .object({
    method: z.enum(PAYMENT_METHODS),
    upiFlow: z.enum(['INTENT', 'QR', 'COLLECT']).optional(),
    vpa: vpa.optional(),
    bankCode: z.string().min(1).max(20).optional(),
  })
  .strict();

function cors(reply: FastifyReply) {
  reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-allow-headers', `${TOKEN_HEADER}, content-type`)
    .header('cache-control', 'no-store');
}

/**
 * The customer's side of a checkout session, called by checkout.js from the merchant's page.
 * Each call needs the session token (header or ?token=); an unknown session and a wrong token look
 * the same. No cookies, customer-safe fields only.
 */
export const publicCheckoutRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  const session = async (req: FastifyRequest) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const { token: queryToken } = z.object({ token: z.string().max(200).optional() }).passthrough().parse(req.query);
    const header = req.headers[TOKEN_HEADER];
    const token = typeof header === 'string' ? header : queryToken;
    if (!token || !verifySessionToken(ctx.customerTokenSecret, id, token)) throw new AppError('NOT_FOUND', 'Checkout session not found');
    return ctx.checkoutSessions.get(id);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/public/checkout/')) cors(reply);
  });
  app.options('/public/checkout/sessions/:id', async (_req, reply) => reply.status(204).send());
  app.options('/public/checkout/sessions/:id/pay', async (_req, reply) => reply.status(204).send());
  app.options('/public/checkout/sessions/:id/status', async (_req, reply) => reply.status(204).send());

  app.get('/public/checkout/sessions/:id', async (req) => ctx.checkoutSessions.view(await session(req)));

  app.post('/public/checkout/sessions/:id/pay', async (req) => {
    const s = await session(req);
    const body = payBody.parse(req.body ?? {});
    const ua = req.headers['user-agent'];
    return {
      payment: await ctx.checkoutSessions.pay(s, { ...body, client: { ip: req.ip, ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 500) } : {}) } }),
    };
  });

  /** Polled by checkout.js: session status and the current payment's customer-safe status. */
  app.get('/public/checkout/sessions/:id/status', async (req) => {
    const v = await ctx.checkoutSessions.view(await session(req));
    return { id: v.id, status: v.status, returnUrl: v.returnUrl, payment: v.payment };
  });

  /** The current UPI QR payment as an SVG image (rendered here, so checkout.js needs no QR library). */
  app.get('/public/checkout/sessions/:id/qr.svg', async (req, reply) => {
    const v = await ctx.checkoutSessions.view(await session(req));
    const action = v.payment?.action;
    if (!action || action.type !== 'UPI_QR' || !action.qrData) throw new AppError('NOT_FOUND', 'No UPI QR code for this checkout');
    const svg = await QRCode.toString(action.qrData, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return reply.header('content-type', 'image/svg+xml').send(svg);
  });
};
