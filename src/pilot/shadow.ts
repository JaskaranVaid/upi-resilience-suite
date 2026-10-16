import { and, desc, eq, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { AUTOPAY_NO_AFA_LIMIT_PAISE, getRuleSet } from '../config/rules.js';
import type { Db } from '../db/client.js';
import { mandates, shadowDebits, type RolloutStage, type WouldRefuse } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { Router } from '../routing/router.js';
import { istMidnight } from '../rules/time.js';
import { isPeak } from '../rules/windows.js';
import { DEFAULT_PLANNING, noticeWindow, plan, type PlanningOptions } from '../scheduler/planning.js';
import type { CreateDebitInput } from '../scheduler/service.js';
import { DebitKeyTaken, liveKeyExists, lockDebitKey } from './keys.js';

export type ShadowDebit = typeof shadowDebits.$inferSelect;
type Mandate = typeof mandates.$inferSelect;

export function shadowDebitView(s: ShadowDebit) {
  return {
    object: 'shadow_debit' as const,
    id: s.id,
    /** The merchant's own system executes it; Merchantflo never does. */
    executedBy: 'MERCHANT' as const,
    mandateId: s.mandateId,
    mandateRef: s.mandateRef,
    orderId: s.orderId,
    amountPaise: s.amountPaise,
    source: s.source,
    rolloutStage: s.rolloutStage,
    requestedAt: s.requestedAt,
    requestedInPeak: s.requestedInPeak,
    dueDate: s.dueDate,
    /** When Merchantflo would have executed it (off-peak, after the notice period). */
    plannedAt: s.plannedAt,
    plannedNoticeDate: s.plannedNoticeDate,
    /** Why Merchantflo would have refused it at intake, if it would have. */
    wouldRefuse: s.wouldRefuse,
    /** Set when this report was for a debit Merchantflo executes (see the pilot runbook). */
    misroutedDebitId: s.liveDebitId,
    outcome:
      s.outcome && s.executedAt
        ? {
            status: s.outcome,
            executedAt: s.executedAt,
            failureKind: s.failureKind,
            failureCode: s.failureCode,
            pspTxnId: s.pspTxnId,
            attempts: s.legacyAttempts,
            reportedAt: s.reportedAt,
          }
        : null,
    createdAt: s.createdAt,
  };
}

/** What live intake would refuse for this debit, if anything (same checks, same order). */
export function wouldRefuse(mandate: Pick<Mandate, 'status' | 'maxAmountPaise' | 'noAfaLimitPaise'>, amountPaise: number): WouldRefuse | null {
  if (mandate.status !== 'ACTIVE') return 'MANDATE_INACTIVE';
  if (amountPaise > mandate.maxAmountPaise) return 'AMOUNT_EXCEEDS_MANDATE';
  if (amountPaise > (mandate.noAfaLimitPaise ?? AUTOPAY_NO_AFA_LIMIT_PAISE)) return 'AFA_REQUIRED';
  return null;
}

/**
 * Shadow debits: debits the merchant's own system executes during a pilot, planned exactly as
 * Merchantflo would have (same planner, same notice window) so the shadow report can compare.
 * Nothing here sends a notice or calls a PSP.
 */
export class ShadowService {
  private readonly opts: PlanningOptions;

  constructor(private readonly deps: { db: Db; clock: Clock; router: Router; opts?: Partial<PlanningOptions> }) {
    this.opts = { ...DEFAULT_PLANNING, ...deps.opts };
  }

  /** When Merchantflo would execute a debit requested at `requestedAt` (the rules in force then). */
  async planFor(mandate: Pick<Mandate, 'eligiblePsps'> | null, id: string, requestedAt: Date, dueDate: string | null) {
    const due = dueDate ? istMidnight(dueDate).getTime() : 0;
    const win = mandate ? await noticeWindow(this.deps.router, mandate as Mandate) : { minNoticeMs: 0 };
    const p = plan({ earliest: new Date(Math.max(requestedAt.getTime(), due)), now: requestedAt, seed: id, noticeDate: null, opts: this.opts, minNoticeMs: win.minNoticeMs });
    return { plannedAt: p.scheduledAt, plannedNoticeDate: p.noticeDate, requestedInPeak: isPeak(requestedAt, getRuleSet(requestedAt).windows) };
  }

  /** Intake for a debit the merchant executes: plan and record it. Returns the existing row on a replay. */
  async createFromIntake(
    merchantId: string,
    mandate: Mandate,
    input: CreateDebitInput,
    rolloutStage: RolloutStage,
  ): Promise<{ shadow: ShadowDebit; created: boolean }> {
    const existing = await this.findByKey(merchantId, input.idempotencyKey);
    if (existing) return { shadow: replay(existing, mandate.id, input), created: false };

    const now = this.deps.clock.now();
    const id = newId('shd');
    const planned = await this.planFor(mandate, id, now, input.dueDate ?? null);
    const row = await this.deps.db.transaction(async (tx) => {
      await lockDebitKey(tx, merchantId, input.idempotencyKey);
      if (await liveKeyExists(tx, merchantId, input.idempotencyKey)) throw new DebitKeyTaken('LIVE');
      const [r] = await tx
        .insert(shadowDebits)
        .values({
          id,
          merchantId,
          mandateId: mandate.id,
          mandateRef: mandate.mandateRef,
          idempotencyKey: input.idempotencyKey,
          orderId: input.orderId ?? null,
          amountPaise: input.amountPaise,
          source: 'MIRRORED',
          rolloutStage,
          requestedAt: now,
          dueDate: input.dueDate ?? null,
          ...planned,
          wouldRefuse: wouldRefuse(mandate, input.amountPaise),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [shadowDebits.merchantId, shadowDebits.idempotencyKey] })
        .returning();
      return r;
    });
    if (row) return { shadow: row, created: true };
    // A concurrent request with the same key inserted first.
    const raced = await this.findByKey(merchantId, input.idempotencyKey);
    if (!raced) throw new AppError('CONFLICT', 'Could not record the debit; retry with the same idempotency key');
    return { shadow: replay(raced, mandate.id, input), created: false };
  }

  async findByKey(merchantId: string, key: string): Promise<ShadowDebit | undefined> {
    const [s] = await this.deps.db.select().from(shadowDebits).where(and(eq(shadowDebits.merchantId, merchantId), eq(shadowDebits.idempotencyKey, key)));
    return s;
  }

  async get(merchantId: string, id: string): Promise<ShadowDebit> {
    const [s] = await this.deps.db.select().from(shadowDebits).where(and(eq(shadowDebits.id, id), eq(shadowDebits.merchantId, merchantId)));
    if (!s) throw new AppError('NOT_FOUND', `Shadow debit ${id} not found`);
    return s;
  }

  /** Newest first; `reported` filters on whether the merchant has reported the outcome. */
  async list(merchantId: string, q: { reported?: boolean; before?: string; limit: number }) {
    const { db } = this.deps;
    const conds: (SQL | undefined)[] = [eq(shadowDebits.merchantId, merchantId)];
    if (q.reported === true) conds.push(isNotNull(shadowDebits.outcome));
    if (q.reported === false) conds.push(isNull(shadowDebits.outcome));
    if (q.before) {
      const [b] = await db.select({ createdAt: shadowDebits.createdAt }).from(shadowDebits).where(and(eq(shadowDebits.id, q.before), eq(shadowDebits.merchantId, merchantId)));
      if (!b) throw new AppError('VALIDATION', 'Unknown "before" cursor');
      conds.push(or(lt(shadowDebits.createdAt, b.createdAt), and(eq(shadowDebits.createdAt, b.createdAt), lt(shadowDebits.id, q.before))));
    }
    const rows = await db
      .select()
      .from(shadowDebits)
      .where(and(...conds))
      .orderBy(desc(shadowDebits.createdAt), desc(shadowDebits.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { data: page.map(shadowDebitView), nextBefore: rows.length > q.limit ? page.at(-1)!.id : null };
  }
}

function replay(existing: ShadowDebit, mandateId: string, input: CreateDebitInput): ShadowDebit {
  if (existing.liveDebitId || existing.mandateId !== mandateId || existing.amountPaise !== input.amountPaise) {
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different debit');
  }
  return existing;
}
