import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { getRuleSet } from '../config/rules.js';
import type { Db } from '../db/client.js';
import { checkoutQuotes, merchants, vendors } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import { recordSavings } from '../ledger/savings.js';
import type { MerchantProfile } from '../rules/mdr.js';
import { splitCart, SplitError, type LineItem, type SplitResult } from '../rules/split.js';
import { quoteMethods, type MethodsQuote, type PaymentMethod } from '../rules/steering.js';

type Merchant = typeof merchants.$inferSelect;

export const QUOTE_TTL_MS = 30 * 60_000;

/** The customer's method choice on a quote, and whether its steering saving is booked. */
export interface QuoteChoice {
  quoteId: string;
  acceptedMethod: PaymentMethod;
  offerTaken: boolean;
  paid: boolean;
  steeringSavingsPaise: number;
}

export interface QuoteResponse extends MethodsQuote {
  quoteId: string;
  ruleSetId: string;
  expiresAt: Date;
}

/**
 * Engine B: cost-aware checkout. Quotes every accepted method under the MDR rules in force,
 * offers discount-only steering, and splits marketplace carts by vendor ownership.
 */
export class CheckoutService {
  constructor(private readonly deps: { db: Db; clock: Clock }) {}

  async quote(merchant: Merchant, amountPaise: number): Promise<QuoteResponse> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const rules = getRuleSet(now);
    const q = quoteMethods({
      amountPaise,
      profile: { category: merchant.category, smallMerchant: merchant.smallMerchant },
      mdr: rules.mdr,
      methodCosts: merchant.methodCosts,
      steering: merchant.steering,
    });
    const quoteId = newId('quo');
    await db.transaction(async (tx) => {
      await tx.insert(checkoutQuotes).values({ id: quoteId, merchantId: merchant.id, amountPaise, ruleSetId: rules.id, quote: q, createdAt: now });
      if (q.offer) {
        await recordSavings(tx, { merchantId: merchant.id, type: 'MDR_STEERING_OFFERED', amountPaise: q.offer.merchantNetSavingsPaise, refId: quoteId, now });
      }
    });
    return { quoteId, ruleSetId: rules.id, expiresAt: new Date(now.getTime() + QUOTE_TTL_MS), ...q };
  }

  /**
   * The customer chose a method at checkout. Records the choice only: a saving is booked once the
   * payment is confirmed paid (`markPaid`), so an abandoned or failed payment never counts.
   */
  async accept(merchantId: string, quoteId: string, method: PaymentMethod) {
    const { db, clock } = this.deps;
    const now = clock.now();
    const { row, q } = await this.choosable(merchantId, quoteId, method);
    if (!row.acceptedMethod) {
      if (now.getTime() - row.createdAt.getTime() > QUOTE_TTL_MS) throw new AppError('CONFLICT', 'Quote expired');
      await db.update(checkoutQuotes).set({ acceptedMethod: method, acceptedAt: now }).where(eq(checkoutQuotes.id, quoteId));
    }
    return this.view(quoteId, q, method, row.paidAt !== null);
  }

  /**
   * The payment for this quote succeeded with `method`. Books the steering saving (net of the
   * discount) exactly once when the customer paid with the offered method. Idempotent per quote.
   */
  async markPaid(merchantId: string, quoteId: string, input: { method: PaymentMethod; paymentReference: string }): Promise<QuoteChoice> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const { row, q } = await this.choosable(merchantId, quoteId, input.method);
    if (row.paidAt) {
      if (row.paymentReference !== input.paymentReference) {
        throw new AppError('CONFLICT', `Quote already paid with reference ${row.paymentReference}`);
      }
      return this.view(quoteId, q, input.method, true);
    }
    if (!row.acceptedMethod && now.getTime() - row.createdAt.getTime() > QUOTE_TTL_MS) throw new AppError('CONFLICT', 'Quote expired');

    const won = await db.transaction(async (tx) => {
      // Only the first report wins; a concurrent report with another reference is a conflict.
      const [updated] = await tx
        .update(checkoutQuotes)
        .set({ acceptedMethod: input.method, acceptedAt: row.acceptedAt ?? now, paidAt: now, paymentReference: input.paymentReference })
        .where(and(eq(checkoutQuotes.id, quoteId), isNull(checkoutQuotes.paidAt)))
        .returning({ id: checkoutQuotes.id });
      if (!updated) return false;
      if (q.offer && q.offer.method === input.method) {
        await recordSavings(tx, { merchantId, type: 'MDR_STEERING_ACCEPTED', amountPaise: q.offer.merchantNetSavingsPaise, refId: quoteId, now });
      }
      return true;
    });
    if (!won) return this.markPaid(merchantId, quoteId, input); // re-read: same reference = replay, else conflict
    return this.view(quoteId, q, input.method, true);
  }

  /** Load a quote for a method choice; the method must have been quoted and match any earlier choice. */
  private async choosable(merchantId: string, quoteId: string, method: PaymentMethod) {
    const [row] = await this.deps.db.select().from(checkoutQuotes).where(and(eq(checkoutQuotes.id, quoteId), eq(checkoutQuotes.merchantId, merchantId)));
    if (!row) throw new AppError('NOT_FOUND', `Quote ${quoteId} not found`);
    const q = row.quote as MethodsQuote;
    if (!q.methods.some((m) => m.method === method)) throw new AppError('VALIDATION', `Method ${method} was not quoted`);
    if (row.acceptedMethod && row.acceptedMethod !== method) throw new AppError('CONFLICT', `Quote already accepted with ${row.acceptedMethod}`);
    return { row, q };
  }

  private view(quoteId: string, q: MethodsQuote, method: PaymentMethod, paid: boolean): QuoteChoice {
    const offerTaken = q.offer?.method === method;
    return {
      quoteId,
      acceptedMethod: method,
      offerTaken,
      paid,
      /** Booked saving: non-zero only once the steered payment is confirmed paid. */
      steeringSavingsPaise: paid && offerTaken && q.offer ? q.offer.merchantNetSavingsPaise : 0,
    };
  }

  async split(merchant: Merchant, lineItems: LineItem[]): Promise<SplitResult & { ruleSetId: string }> {
    const { db, clock } = this.deps;
    const rules = getRuleSet(clock.now());
    const ids = [...new Set(lineItems.map((i) => i.vendorId))];
    const rows = ids.length
      ? await db.select().from(vendors).where(and(eq(vendors.merchantId, merchant.id), inArray(vendors.externalId, ids)))
      : [];
    const profiles: Record<string, MerchantProfile> = Object.fromEntries(
      rows.map((v) => [v.externalId, { category: v.category, smallMerchant: v.smallMerchant }]),
    );
    try {
      const result = splitCart({
        lineItems,
        vendors: profiles,
        platformProfile: { category: merchant.category, smallMerchant: merchant.smallMerchant },
        mdr: rules.mdr,
      });
      return { ...result, ruleSetId: rules.id };
    } catch (e) {
      if (e instanceof SplitError) throw new AppError('SPLIT_INVALID', e.message);
      throw e;
    }
  }
}
