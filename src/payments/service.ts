import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { paymentAttempts, payments } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents, SYSTEM } from '../events/record.js';
import { newId } from '../ids.js';
import type { PspResult } from '../psp/types.js';
import type { AttemptRecord, Router } from '../routing/router.js';
import type { InitialOutcome, TrackingService } from '../tracking/service.js';
import { applyPaymentOutcome, paymentView, type Payment } from './outcome.js';

export { paymentView, type Payment };

export interface CreatePaymentInput {
  amountPaise: number;
  payerVpa: string;
  idempotencyKey: string;
  orderId?: string;
  quoteId?: string;
  /** Required by some PSPs (e.g. Cashfree) to create a collect. */
  customerPhone?: string;
}

function initialOutcome(result: PspResult, pspId: string | null): InitialOutcome {
  if (!pspId) return { kind: 'NOT_SUBMITTED' };
  switch (result.kind) {
    case 'SUCCESS':
      return { kind: 'SUCCEEDED', ...(result.upiRrn ? { upiRrn: result.upiRrn } : {}) };
    case 'PENDING':
      return { kind: 'PENDING' };
    case 'BUSINESS_DECLINE':
      return { kind: 'FAILED_BUSINESS' };
    case 'TECHNICAL_DECLINE':
    case 'NOT_FOUND':
      return { kind: 'FAILED_TECHNICAL' };
  }
}

/** One-off UPI collect at checkout, routed through the smart router (Phase 2). */
export class PaymentService {
  constructor(private readonly deps: { db: Db; clock: Clock; router: Router; pspIds: string[]; tracking: TrackingService }) {}

  async create(merchantId: string, input: CreatePaymentInput): Promise<{ payment: Payment; created: boolean }> {
    const { db, clock, router, pspIds, tracking } = this.deps;
    const existing = await this.findByKey(merchantId, input.idempotencyKey);
    if (existing) return this.replay(existing, input);

    const now = clock.now();
    const id = newId('pay');
    try {
      await db.transaction(async (tx) => {
        await tx.insert(payments).values({
          id,
          merchantId,
          amountPaise: input.amountPaise,
          payerVpa: input.payerVpa,
          idempotencyKey: input.idempotencyKey,
          orderId: input.orderId ?? null,
          quoteId: input.quoteId ?? null,
          state: 'PENDING',
          createdAt: now,
          updatedAt: now,
        });
        await recordEvents(tx, { merchantId, subjectType: 'COLLECT', subjectId: id, actor: SYSTEM, now }, [{ type: 'PAYMENT_CREATED' }]);
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
      ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
      baseRef: id,
    });
    await this.recordAttempts(merchantId, id, outcome.attempts);
    const pspId = outcome.pspId ?? null;
    const doneAt = clock.now();
    const payment = await db.transaction(async (tx) => {
      await recordEvents(tx, { merchantId, subjectType: 'COLLECT', subjectId: id, actor: SYSTEM, now: doneAt }, [
        { type: 'PAYMENT_SUBMITTED', data: { pspId, attempts: outcome.attempts.length } },
      ]);
      const p = await applyPaymentOutcome(tx, { id, result: outcome.result, pspId, hadTechnicalDecline: outcome.hadTechnicalDecline, now: doneAt });
      await tracking.recordOutcome(tx, {
        merchantId,
        subjectType: 'COLLECT',
        subjectId: id,
        pspId,
        txnRef: outcome.txnRef ?? null,
        outcome: initialOutcome(outcome.result, pspId),
        now: doneAt,
      });
      return p;
    });
    return { payment, created: true };
  }

  /**
   * Read the canonical payment. Read-only: pending payments are resolved by the status
   * poller, never by a read (Phase 3, C2).
   */
  async get(merchantId: string, paymentId: string): Promise<Payment> {
    const [p] = await this.deps.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchantId)));
    if (!p) throw new AppError('NOT_FOUND', `Payment ${paymentId} not found`);
    return p;
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
      records.map((a, seq) => ({
        id: newId('att'),
        merchantId,
        paymentId,
        pspId: a.pspId,
        txnRef: a.txnRef,
        op: a.op,
        outcome: a.result.kind,
        code: 'code' in a.result ? a.result.code : null,
        latencyMs: a.latencyMs,
        seq,
        probe: a.probe ?? false,
        createdAt: this.deps.clock.now(),
      })),
    );
  }
}
