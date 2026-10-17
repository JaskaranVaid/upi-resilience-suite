import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { merchantOf } from '../app.js';
import { acceptQuote, createCheckoutSession, idParam, quotePaid, quoteRequest, splitRequest } from '../schemas.js';
import { sessionToken } from '../../checkout/sessions.js';
import { withIdempotencyKey } from './mandates.js';

export const checkoutRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  /**
   * Start a checkout the customer completes in the browser with checkout.js. Returns the session and
   * the token checkout.js needs (scoped to this session only).
   */
  app.post('/v1/checkout/sessions', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = createCheckoutSession.parse(withIdempotencyKey(req));
    const { session, created } = await ctx.checkoutSessions.create(merchant, body);
    return reply.status(created ? 201 : 200).send({ ...(await ctx.checkoutSessions.view(session)), clientToken: sessionToken(ctx.customerTokenSecret, session.id) });
  });

  app.get('/v1/checkout/sessions/:id', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    return ctx.checkoutSessions.view(await ctx.checkoutSessions.get(id, merchant.id));
  });

  /** Engine B: cost every accepted method and, where worthwhile, a discount-only steering offer. */
  app.post('/v1/checkout/quote', async (req, reply) => {
    const merchant = merchantOf(req);
    const body = quoteRequest.parse(req.body);
    return reply.status(201).send(await ctx.checkout.quote(merchant, body.amountPaise));
  });

  app.post('/v1/checkout/quotes/:id/accept', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    const { method } = acceptQuote.parse(req.body);
    return ctx.checkout.accept(merchant.id, id, method);
  });

  /** The payment for this quote succeeded: books the steering saving if the offered method was used. */
  app.post('/v1/checkout/quotes/:id/paid', async (req) => {
    const merchant = merchantOf(req);
    const { id } = idParam.parse(req.params);
    return ctx.checkout.markPaid(merchant.id, id, quotePaid.parse(req.body));
  });

  /**
   * Marketplace split estimate: one leg per vendor, where each vendor is the merchant of record for
   * its own items, with each leg's MDR. Creates no payments. Never splits a single vendor's amount.
   */
  app.post('/v1/checkout/split', async (req) => {
    const merchant = merchantOf(req);
    const body = splitRequest.parse(req.body);
    return ctx.checkout.split(merchant, body.lineItems);
  });
};
