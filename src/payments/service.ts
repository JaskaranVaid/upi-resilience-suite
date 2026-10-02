import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { paymentAttempts, payments } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import { recordSavings } from '../ledger/savings.js';
import type { PspResult } from '../psp/types.js';
import type { AttemptRecord, Router } from '../routing/router.js';
import { enqueueWebhook } from '../webhooks/outbox.js';

export type Payment = typeof payments.$inferSelect;

export interface CreatePaymentInput {
  amountPaise: number;
  payerVpa: string;
  idempotencyKey: string;
  quoteId?: string;
}

export function paymentView(p: Payment) {
  return {
    id: p.id,
    amountPaise: p.amountPaise,
    payerVpa: p.payerVpa,
    state: p.state,
    pspId: p.pspId,
    pspTxnId: p.pspTxnId,
    lastErrorCode: p.lastErrorCode,
    quoteId: p.quoteId,
    createdAt: p.createdAt,
  };
}

/** One-off UPI collect at checkout, routed through the smart router (Phase 2). */
export class PaymentService {
  constructor(private readonly deps: { db: Db; clock: Clock; router: Router; pspIds: string[] }) {}

  async create(merchantId: string, input: CreatePaymentInput): Promise<{ payment: Payment; created: boolean }> {
    const { db, clock, router, pspIds } = this.deps;
    const existing = await this.findByKey(merchantId, input.idempotencyKey);
    if (existing) return this.replay(existing, input);

    const now = clock.now();
    const id = newId('pay');
    try {
      await db.insert(payments).values({
        id,
        merchantId,
        amountPaise: input.amountPaise,
        payerVpa: input.payerVpa,
        idempotencyKey: input.idempotencyKey,
        quoteId: input.quoteId ?? null,
        state: 'PENDING',
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      const raced = await this.findByKey(merchantId, input.idempotencyKey);
      if (raced) return this.replay(raced, input);
      throw e;
    }

    const outcome = await router.execute({
      op: 'collect',
      candidates: pspIds,
      amountPaise: input.amountPaise,
      payerVpa: input.payerVpa,
      baseRef: id,
    });
    await this.recordAttempts(merchantId, id, outcome.attempts);
    const payment = await this.settle(id, outcome.result, outcome.pspId ?? null, outcome.hadTechnicalDecline);
    return { payment, created: true };
  }

  /** Fetch a payment; a PENDING one is refreshed from the PSP first. */
  async get(merchantId: string, paymentId: string): Promise<Payment> {
    const { db, router } = this.deps;
    const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchantId)));
    if (!p) throw new AppError('NOT_FOUND', `Payment ${paymentId} not found`);
    if (p.state !== 'PENDING' || !p.pspId) return p;

    const [last] = await db
      .select()
      .from(paymentAttempts)
      // The router uses one txnRef per PSP, so any collect attempt on that PSP carries it.
      .where(and(eq(paymentAttempts.paymentId, p.id), eq(paymentAttempts.pspId, p.pspId), eq(paymentAttempts.op, 'collect')))
      .limit(1);
    if (!last) return p;
    const result = await router.status(p.pspId, last.txnRef);
    if (result.kind === 'PENDING' || result.kind === 'NOT_FOUND') return p;
    return this.settle(p.id, result, p.pspId, false);
  }

  private async settle(id: string, result: PspResult, pspId: string | null, hadTechnicalDecline: boolean): Promise<Payment> {
    const { db, clock } = this.deps;
    const now = clock.now();
    return db.transaction(async (tx) => {
      const state = result.kind === 'SUCCESS' ? 'SUCCEEDED' : result.kind === 'PENDING' ? 'PENDING' : 'FAILED';
      const [row] = await tx
        .update(payments)
        .set({
          state,
          pspId,
          pspTxnId: result.kind === 'SUCCESS' ? result.pspTxnId : null,
          lastErrorCode: 'code' in result ? result.code : null,
          updatedAt: now,
        })
        .where(eq(payments.id, id))
        .returning();
      const p = row!;
      if (state === 'SUCCEEDED') {
        await enqueueWebhook(tx, { merchantId: p.merchantId, event: 'payment.succeeded', payload: paymentView(p), now });
        if (hadTechnicalDecline) {
          await recordSavings(tx, { merchantId: p.merchantId, type: 'TD_RECOVERED', amountPaise: p.amountPaise, refId: p.id, now });
        }
      } else if (state === 'FAILED') {
        await enqueueWebhook(tx, { merchantId: p.merchantId, event: 'payment.failed', payload: paymentView(p), now });
      }
      return p;
    });
  }

  private async findByKey(merchantId: string, key: string): Promise<Payment | undefined> {
    const [p] = await this.deps.db.select().from(payments).where(and(eq(payments.merchantId, merchantId), eq(payments.idempotencyKey, key)));
    return p;
  }

  private replay(existing: Payment, input: CreatePaymentInput) {
    if (existing.amountPaise !== input.amountPaise || existing.payerVpa !== input.payerVpa) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different payment');
    }
    return { payment: existing, created: false };
  }

  private async recordAttempts(merchantId: string, paymentId: string, records: AttemptRecord[]) {
    if (records.length === 0) return;
    await this.deps.db.insert(paymentAttempts).values(
      records.map((a) => ({
        id: newId('att'),
        merchantId,
        paymentId,
        pspId: a.pspId,
        txnRef: a.txnRef,
        op: a.op,
        outcome: a.result.kind,
        code: 'code' in a.result ? a.result.code : null,
        latencyMs: a.latencyMs,
        createdAt: this.deps.clock.now(),
      })),
    );
  }
}
