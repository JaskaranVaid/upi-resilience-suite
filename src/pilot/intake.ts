import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mandates, merchants } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { CreateDebitInput, Debit, SchedulerService } from '../scheduler/service.js';
import { DebitKeyTaken } from './keys.js';
import { executorFor } from './rollout.js';
import type { ShadowDebit, ShadowService } from './shadow.js';

type Merchant = typeof merchants.$inferSelect;

export type IntakeResult = { kind: 'LIVE'; debit: Debit; created: boolean } | { kind: 'SHADOW'; shadow: ShadowDebit; created: boolean };

/**
 * Every recurring debit request enters here (POST /v1/mandates/:id/debits). It decides, once, who
 * executes it — Merchantflo, or the merchant's own system during a pilot — and a retry with the same
 * idempotency key always returns that first decision, whatever the stage is by then.
 */
export class DebitIntake {
  constructor(private readonly deps: { db: Db; scheduler: SchedulerService; shadow: ShadowService }) {}

  async request(merchant: Merchant, mandateId: string, input: CreateDebitInput): Promise<IntakeResult> {
    const { scheduler, shadow } = this.deps;
    // Replays first, live before shadow: a reported execution of a live debit shares its key.
    if (await scheduler.findByKey(merchant.id, input.idempotencyKey)) return this.live(merchant, mandateId, input);
    if (await shadow.findByKey(merchant.id, input.idempotencyKey)) return this.shadow(merchant, await this.mandate(merchant.id, mandateId), input);

    const mandate = await this.mandate(merchant.id, mandateId);
    return executorFor(merchant, mandate.id) === 'MERCHANTFLO' ? this.live(merchant, mandateId, input) : this.shadow(merchant, mandate, input);
  }

  private async live(merchant: Merchant, mandateId: string, input: CreateDebitInput): Promise<IntakeResult> {
    try {
      return { kind: 'LIVE', ...(await this.deps.scheduler.createDebit(merchant.id, mandateId, input, { rolloutStage: merchant.rolloutStage })) };
    } catch (e) {
      // A request racing this one recorded the key as a shadow debit: that is the debit.
      if (e instanceof DebitKeyTaken) return this.shadow(merchant, await this.mandate(merchant.id, mandateId), input);
      throw e;
    }
  }

  private async shadow(merchant: Merchant, mandate: typeof mandates.$inferSelect, input: CreateDebitInput): Promise<IntakeResult> {
    try {
      return { kind: 'SHADOW', ...(await this.deps.shadow.createFromIntake(merchant.id, mandate, input, merchant.rolloutStage)) };
    } catch (e) {
      if (e instanceof DebitKeyTaken) return { kind: 'LIVE', ...(await this.deps.scheduler.createDebit(merchant.id, mandate.id, input)) };
      throw e;
    }
  }

  private async mandate(merchantId: string, mandateId: string) {
    const [m] = await this.deps.db.select().from(mandates).where(and(eq(mandates.id, mandateId), eq(mandates.merchantId, merchantId)));
    if (!m) throw new AppError('NOT_FOUND', `Mandate ${mandateId} not found`);
    return m;
  }
}
