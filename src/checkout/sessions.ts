import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { checkoutQuotes, checkoutSessions, merchants, payments, type CheckoutSessionStatus } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { PaymentService } from '../payments/service.js';
import type { PspRegistry } from '../psp/registry.js';
import type { CustomerAction, CustomerDebit, PaymentChannel } from '../psp/types.js';
import type { PaymentQueryService } from '../query/payments.js';
import type { MethodsQuote, PaymentMethod } from '../rules/steering.js';
import { customerStatus } from '../tracking/derive.js';
import type { CheckoutService } from './service.js';

type Merchant = typeof merchants.$inferSelect;
type Session = typeof checkoutSessions.$inferSelect;

export const SESSION_TTL_MS = 30 * 60_000;
const PAY_LOCK_MS = 60_000;

/** Which payment channels serve each checkout method. */
const CHANNELS_FOR: Record<PaymentMethod, PaymentChannel[]> = {
  UPI: ['UPI_INTENT', 'UPI_QR', 'UPI_COLLECT'],
  NETBANKING: ['NETBANKING'],
  CARD: ['CARD'],
  RUPAY_DEBIT: ['CARD'],
};

/** The checkout method a payment channel belongs to (for booking steering savings). */
export function methodOfChannel(channel: PaymentChannel): PaymentMethod {
  return channel === 'NETBANKING' ? 'NETBANKING' : channel === 'CARD' ? 'CARD' : 'UPI';
}

export interface CreateSessionInput {
  amountPaise: number;
  orderId?: string;
  customer?: { phone?: string; vpa?: string };
  returnUrl?: string;
  expiresInMinutes?: number;
  idempotencyKey?: string;
}

export interface PayInput {
  method: PaymentMethod;
  /** UPI only: INTENT (phone), QR (desktop) or COLLECT (needs vpa). Default INTENT. */
  upiFlow?: 'INTENT' | 'QR' | 'COLLECT';
  vpa?: string;
  bankCode?: string;
  client?: { ip?: string; userAgent?: string };
}

/** Bearer token for the customer's browser: reads and pays exactly one session. */
export function sessionToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`cks:v1:${sessionId}`).digest('base64url');
}

export function verifySessionToken(secret: string, sessionId: string, token: string): boolean {
  const a = Buffer.from(sessionToken(secret, sessionId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checkout sessions: Engine B's quote plus the customer's payment, completed in the browser.
 * The merchant's server creates a session; checkout.js shows the methods (with any steering
 * discount) and starts the payment. A session holds at most one live payment.
 */
export class CheckoutSessionService {
  constructor(
    private readonly deps: { db: Db; clock: Clock; checkout: CheckoutService; payments: PaymentService; psps: PspRegistry; queries: PaymentQueryService; tokenSecret: string },
  ) {}

  async create(merchant: Merchant, input: CreateSessionInput): Promise<{ session: Session; created: boolean }> {
    const { db, clock, checkout } = this.deps;
    if (input.idempotencyKey) {
      const [existing] = await db.select().from(checkoutSessions).where(and(eq(checkoutSessions.merchantId, merchant.id), eq(checkoutSessions.idempotencyKey, input.idempotencyKey)));
      if (existing) {
        if (existing.amountPaise !== input.amountPaise) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different checkout');
        return { session: existing, created: false };
      }
    }
    await this.deps.psps.requireForMerchant(merchant.id);
    const quote = await checkout.quote(merchant, input.amountPaise);
    const now = clock.now();
    const [session] = await db
      .insert(checkoutSessions)
      .values({
        id: newId('cks'),
        merchantId: merchant.id,
        quoteId: quote.quoteId,
        idempotencyKey: input.idempotencyKey ?? null,
        amountPaise: input.amountPaise,
        orderId: input.orderId ?? null,
        customerPhone: input.customer?.phone ?? null,
        customerVpa: input.customer?.vpa ?? null,
        returnUrl: input.returnUrl ?? null,
        expiresAt: new Date(now.getTime() + (input.expiresInMinutes ?? SESSION_TTL_MS / 60_000) * 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [checkoutSessions.merchantId, checkoutSessions.idempotencyKey] })
      .returning();
    if (!session) return this.create(merchant, input); // lost a race with the same key: replay
    return { session, created: true };
  }

  async get(sessionId: string, merchantId?: string): Promise<Session> {
    const conds = [eq(checkoutSessions.id, sessionId)];
    if (merchantId) conds.push(eq(checkoutSessions.merchantId, merchantId));
    const [s] = await this.deps.db.select().from(checkoutSessions).where(and(...conds));
    if (!s) throw new AppError('NOT_FOUND', 'Checkout session not found');
    return s;
  }

  /** What the checkout page shows: methods the merchant can take, payable amounts, the offer, progress. */
  async view(session: Session) {
    const { db, psps } = this.deps;
    const [q] = await db.select().from(checkoutQuotes).where(eq(checkoutQuotes.id, session.quoteId));
    const quote = q!.quote as MethodsQuote;
    const channels = new Set((await psps.forMerchant(session.merchantId)).flatMap((a) => a.capabilities.channels));
    const rank = (m: { method: PaymentMethod; recommended: boolean }) => (m.method === 'UPI' ? 0 : m.recommended ? 1 : 2);
    const methods = quote.methods
      .filter((m) => CHANNELS_FOR[m.method].some((c) => channels.has(c)))
      .map((m) => ({
        method: m.method,
        payablePaise: m.customerPayablePaise,
        discountPaise: m.customerDiscountPaise,
        recommended: quote.offer?.method === m.method,
        ...(m.method === 'UPI' ? { upiFlows: (['INTENT', 'QR', 'COLLECT'] as const).filter((f) => channels.has(`UPI_${f}` as PaymentChannel)) } : {}),
      }))
      // UPI first (what Indian customers expect), then the recommended method, then the rest by name.
      .sort((a, b) => rank(a) - rank(b) || a.method.localeCompare(b.method));
    return {
      id: session.id,
      amountPaise: session.amountPaise,
      orderId: session.orderId,
      status: this.statusOf(session),
      expiresAt: session.expiresAt,
      returnUrl: session.returnUrl,
      methods,
      payment: await this.paymentSummary(session),
    };
  }

  /** Start (or return the live) payment for a session. */
  async pay(session: Session, input: PayInput) {
    const { db, clock, payments: paymentService, checkout } = this.deps;
    const now = clock.now();
    const status = this.statusOf(session);
    if (status === 'PAID') throw new AppError('CONFLICT', 'This checkout is already paid');
    if (status === 'EXPIRED') throw new AppError('CONFLICT', 'This checkout has expired — start a new one');

    // A live payment stands: never start a second one alongside it.
    const live = session.paymentId ? await this.payment(session.paymentId) : undefined;
    if (live?.state === 'PENDING') return this.paymentSummary(session);

    const [q] = await db.select().from(checkoutQuotes).where(eq(checkoutQuotes.id, session.quoteId));
    const quote = q!.quote as MethodsQuote;
    const option = quote.methods.find((m) => m.method === input.method);
    if (!option) throw new AppError('VALIDATION', `${input.method} is not offered for this checkout`);
    const channel: PaymentChannel =
      input.method === 'UPI' ? (`UPI_${input.upiFlow ?? 'INTENT'}` as PaymentChannel) : input.method === 'NETBANKING' ? 'NETBANKING' : 'CARD';
    const vpa = input.vpa ?? session.customerVpa ?? undefined;
    if (channel === 'UPI_COLLECT' && !vpa) throw new AppError('VALIDATION', 'A UPI ID (VPA) is needed to send a collect request');

    // Claim the session for this payment start (two clicks or tabs can't start two payments).
    const [claimed] = await db
      .update(checkoutSessions)
      .set({ payLockUntil: new Date(now.getTime() + PAY_LOCK_MS), paymentCount: sql`${checkoutSessions.paymentCount} + 1`, updatedAt: now })
      .where(and(eq(checkoutSessions.id, session.id), or(isNull(checkoutSessions.payLockUntil), lt(checkoutSessions.payLockUntil, now))))
      .returning();
    if (!claimed) throw new AppError('CONFLICT', 'A payment for this checkout is being started — check its status');
    try {
      // The quote's method decides the amount: a steered method's discount is taken off here.
      await checkout.accept(session.merchantId, session.quoteId, input.method).catch(() => undefined); // first choice recorded; later retries may switch method
      const { payment } = await paymentService.create(session.merchantId, {
        amountPaise: option.customerPayablePaise,
        channel,
        ...(channel === 'UPI_COLLECT' ? { payerVpa: vpa! } : {}),
        idempotencyKey: `${session.id}:${claimed.paymentCount}`,
        ...(session.orderId ? { orderId: session.orderId } : {}),
        quoteId: session.quoteId,
        ...(session.customerPhone ? { customerPhone: session.customerPhone } : {}),
        ...(input.bankCode ? { netbankingBankCode: input.bankCode } : {}),
        ...(input.client ? { client: input.client } : {}),
      });
      await db.update(checkoutSessions).set({ paymentId: payment.id, payLockUntil: null, updatedAt: clock.now() }).where(eq(checkoutSessions.id, session.id));
      return this.paymentSummary({ ...session, paymentId: payment.id });
    } catch (e) {
      await db.update(checkoutSessions).set({ payLockUntil: null }).where(eq(checkoutSessions.id, session.id));
      throw e;
    }
  }

  statusOf(session: Session): CheckoutSessionStatus {
    if (session.status === 'OPEN' && this.deps.clock.now() > session.expiresAt) return 'EXPIRED';
    return session.status;
  }

  private async payment(id: string) {
    const [p] = await this.deps.db.select().from(payments).where(eq(payments.id, id));
    return p;
  }

  /** The current payment, as the customer may see it. */
  private async paymentSummary(session: Session) {
    if (!session.paymentId) return null;
    const p = await this.payment(session.paymentId);
    if (!p) return null;
    const row = await this.deps.queries.rowFor(session.merchantId, 'COLLECT', p.id);
    const s = customerStatus(row.merchantStatus, row.customerDebit as CustomerDebit);
    return {
      id: p.id,
      method: methodOfChannel(p.channel),
      channel: p.channel,
      amountPaise: p.amountPaise,
      status: s.status,
      message: s.message,
      action: (p.state === 'PENDING' ? p.customerAction : null) as CustomerAction | null,
    };
  }
}
