import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { getRuleSet } from '../config/rules.js';
import type { Db } from '../db/client.js';
import { debits, mandates } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { Router } from '../routing/router.js';
import { istMidnight } from '../rules/time.js';
import { isPeak } from '../rules/windows.js';
import { recordEvents, SYSTEM } from '../events/record.js';
import { enqueueWebhook } from '../webhooks/outbox.js';
import { DEFAULT_PLANNING, deferredNoticeAt, noticeWindow, plan, sendNotice, type PlanningOptions } from './planning.js';

export type Debit = typeof debits.$inferSelect;

export interface CreateDebitInput {
  amountPaise: number;
  idempotencyKey: string;
  /** Earliest IST date the merchant wants this debit to run (billing date). */
  dueDate?: string;
  /** Merchant's own invoice/order reference. */
  orderId?: string;
}

export interface SchedulerOptions extends PlanningOptions {
  maxAttempts: number;
}

export const DEFAULT_SCHEDULER: SchedulerOptions = { ...DEFAULT_PLANNING, maxAttempts: 3 };

export function debitView(d: Debit) {
  return {
    id: d.id,
    mandateId: d.mandateId,
    orderId: d.orderId,
    amountPaise: d.amountPaise,
    state: d.state,
    requestedAt: d.requestedAt,
    requestedInPeak: d.requestedInPeak,
    dueDate: d.dueDate,
    scheduledAt: d.scheduledAt,
    noticeDate: d.noticeDate,
    /** Notice not sent yet because the provider only accepts notices a few days ahead. */
    noticePending: d.noticeDate === null,
    attempts: d.attempts,
    maxAttempts: d.maxAttempts,
    lastErrorCode: d.lastErrorCode,
    pspTxnId: d.pspTxnId,
    completedAt: d.completedAt,
  };
}

/**
 * Engine A intake. Merchants hand us every recurring debit, whenever their billing system
 * fires; we pick a compliant slot, send the pre-debit notice, and persist the schedule.
 */
export class SchedulerService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly router: Router;
  private readonly opts: SchedulerOptions;

  constructor(deps: { db: Db; clock: Clock; router: Router; opts?: Partial<SchedulerOptions> }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.router = deps.router;
    this.opts = { ...DEFAULT_SCHEDULER, ...deps.opts };
  }

  async createDebit(merchantId: string, mandateId: string, input: CreateDebitInput): Promise<{ debit: Debit; created: boolean }> {
    const existing = await this.findByKey(merchantId, input.idempotencyKey);
    if (existing) return this.replay(existing, mandateId, input);

    const [mandate] = await this.db
      .select()
      .from(mandates)
      .where(and(eq(mandates.id, mandateId), eq(mandates.merchantId, merchantId)));
    if (!mandate) throw new AppError('NOT_FOUND', `Mandate ${mandateId} not found`);
    if (mandate.status !== 'ACTIVE') throw new AppError('MANDATE_INACTIVE', `Mandate is ${mandate.status}`);
    if (input.amountPaise > mandate.maxAmountPaise) {
      throw new AppError('AMOUNT_EXCEEDS_MANDATE', `Amount exceeds mandate limit of ${mandate.maxAmountPaise} paise`);
    }

    const now = this.clock.now();
    const id = newId('dbt');
    const due = input.dueDate ? istMidnight(input.dueDate) : now;
    const win = noticeWindow(this.router, mandate);
    const p = plan({ earliest: new Date(Math.max(now.getTime(), due.getTime())), now, seed: id, noticeDate: null, opts: this.opts, minNoticeMs: win.minNoticeMs });
    // Too far ahead for the provider to accept a notice: the worker sends it later, then schedules.
    const noticeAt = deferredNoticeAt(p.scheduledAt, now, win, id);
    // Notice first: if it fails nothing is persisted and the merchant can retry with the same key.
    if (!noticeAt) await sendNotice(this.router, mandate, id, input.amountPaise, p.noticeDate);

    try {
      const debit = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(debits)
          .values({
            id,
            merchantId,
            mandateId,
            amountPaise: input.amountPaise,
            idempotencyKey: input.idempotencyKey,
            orderId: input.orderId ?? null,
            state: 'SCHEDULED',
            requestedAt: now,
            requestedInPeak: isPeak(now, getRuleSet(now).windows),
            dueDate: input.dueDate ?? null,
            scheduledAt: noticeAt ?? p.scheduledAt,
            noticeDate: noticeAt ? null : p.noticeDate,
            noticeSentAt: noticeAt ? null : now,
            maxAttempts: this.opts.maxAttempts,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await enqueueWebhook(tx, { merchantId, event: 'debit.scheduled', payload: debitView(row!), now });
        await recordEvents(tx, { merchantId, subjectType: 'AUTOPAY', subjectId: id, actor: SYSTEM, now }, [{ type: 'PAYMENT_CREATED' }]);
        return row!;
      });
      return { debit, created: true };
    } catch (e) {
      // Lost a race with a concurrent request carrying the same key.
      const raced = await this.findByKey(merchantId, input.idempotencyKey);
      if (raced) return this.replay(raced, mandateId, input);
      throw e;
    }
  }

  async getDebit(merchantId: string, debitId: string): Promise<Debit> {
    const [d] = await this.db.select().from(debits).where(and(eq(debits.id, debitId), eq(debits.merchantId, merchantId)));
    if (!d) throw new AppError('NOT_FOUND', `Debit ${debitId} not found`);
    return d;
  }

  private async findByKey(merchantId: string, key: string): Promise<Debit | undefined> {
    const [d] = await this.db.select().from(debits).where(and(eq(debits.merchantId, merchantId), eq(debits.idempotencyKey, key)));
    return d;
  }

  private replay(existing: Debit, mandateId: string, input: CreateDebitInput) {
    if (existing.mandateId !== mandateId || existing.amountPaise !== input.amountPaise) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different debit');
    }
    return { debit: existing, created: false };
  }
}
