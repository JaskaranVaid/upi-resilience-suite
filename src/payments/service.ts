import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { paymentAttempts, payments } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents, SYSTEM } from '../events/record.js';
import { newId } from '../ids.js';
import type { PaymentChannel, PspResult } from '../psp/types.js';
import { assertMayStartPayment, type ExecutionControl } from '../ops-console/pauses.js';
import type { AttemptRecord, Router } from '../routing/router.js';
import type { InitialOutcome, TrackingService } from '../tracking/service.js';
import { applyPaymentOutcome, paymentView, type Payment } from './outcome.js';

export { paymentView, type Payment };

export interface CreatePaymentInput {
  amountPaise: number;
  /** Default: UPI_COLLECT when payerVpa is given, else UPI_INTENT. */
  channel?: PaymentChannel;
  /** Required for UPI_COLLECT. */
  payerVpa?: string;
  netbankingBankCode?: string;
  /** The customer's device (IP, user agent), forwarded to PSPs that require it. */
  client?: { ip?: string; userAgent?: string };
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
  constructor(private readonly deps: { db: Db; clock: Clock; router: Router; tracking: TrackingService; pauses?: ExecutionControl }) {}

  async create(merchantId: string, input: CreatePaymentInput): Promise<{ payment: Payment; created: boolean }> {
    const { db, clock, router, tracking } = this.deps;
    const existing = await this.findByKey(merchantId, input.idempotencyKey);
    if (existing) return this.replay(existing, input);
    // The kill switch: no new payment starts while this merchant (or everything) is paused. One
    // lookup serves this check, the all-PSPs-paused check and routing.
    const pauses = await this.deps.pauses?.state();
    if (pauses) assertMayStartPayment(pauses, merchantId);

    const channel: PaymentChannel = input.channel ?? (input.payerVpa ? 'UPI_COLLECT' : 'UPI_INTENT');
    if (channel === 'UPI_COLLECT' && !input.payerVpa) throw new AppError('VALIDATION', 'payerVpa is required for a UPI collect');
    const adapters = (await router.psps.requireForMerchant(merchantId)).filter((a) => a.capabilities.channels.includes(channel));
    if (adapters.length === 0) throw new AppError('NO_PSP_CONNECTED', `None of this merchant's payment providers accepts ${channel} payments`);
    const paused = pauses?.psps ?? new Set<string>();
    if (adapters.every((a) => paused.has(a.id))) {
      throw new AppError('EXECUTION_PAUSED', "This merchant's payment providers are paused by Merchantflo operations; please retry later");
    }
    const pspIds = adapters.map((a) => a.id);
    const needsPhone = adapters.filter((a) => a.capabilities.collectRequires.includes('customerPhone')).map((a) => a.id);
    if (needsPhone.length > 0 && !input.customerPhone) {
      throw new AppError('VALIDATION', `customerPhone is required by the payment provider (${needsPhone.join(', ')})`);
    }

    const now = clock.now();
    const id = newId('pay');
    try {
      await db.transaction(async (tx) => {
        await tx.insert(payments).values({
          id,
          merchantId,
          amountPaise: input.amountPaise,
          channel,
          payerVpa: input.payerVpa ?? null,
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
      pausedPsps: paused,
      amountPaise: input.amountPaise,
      channel,
      ...(input.payerVpa ? { payerVpa: input.payerVpa } : {}),
      ...(input.netbankingBankCode ? { netbankingBankCode: input.netbankingBankCode } : {}),
      ...(input.client ? { client: input.client } : {}),
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
      let p = await applyPaymentOutcome(tx, { id, result: outcome.result, pspId, hadTechnicalDecline: outcome.hadTechnicalDecline, now: doneAt });
      if (outcome.result.kind === 'PENDING' && outcome.result.action) {
        // Kept on the payment so an idempotent replay hands back the same deeplink/QR/redirect.
        const [withAction] = await tx.update(payments).set({ customerAction: outcome.result.action }).where(eq(payments.id, id)).returning();
        p = withAction!;
      }
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
    if (existing.amountPaise !== input.amountPaise || (existing.payerVpa ?? undefined) !== input.payerVpa) {
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
