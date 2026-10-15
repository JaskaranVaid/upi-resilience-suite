import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { merchantOf } from '../app.js';
import { acceptQuote, idParam, quotePaid, quoteRequest, splitRequest } from '../schemas.js';

export const checkoutRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
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
   * Marketplace split: one payment leg per vendor, where each vendor is the merchant of
   * record for its own items. Never splits a single vendor's amount.
   */
  app.post('/v1/checkout/split', async (req) => {
    const merchant = merchantOf(req);
    const body = splitRequest.parse(req.body);
    return ctx.checkout.split(merchant, body.lineItems);
  });
};
