import { createHash } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db, DbOrTx } from '../db/client.js';
import { merchants, rolloutChanges, type OperatorRole, type RolloutStage } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { OperatorService } from '../ops-console/operators.js';
import { enqueueWebhook } from '../webhooks/outbox.js';

type Merchant = typeof merchants.$inferSelect;
export type RolloutChange = typeof rolloutChanges.$inferSelect;

/** Who executes a debit: Merchantflo (notice + execution), or the merchant's own system (we only plan). */
export type Executor = 'MERCHANTFLO' | 'MERCHANT';

export interface RolloutTarget {
  stage: RolloutStage;
  canaryPercent?: number | null;
}

export interface RolloutActor {
  /** Null for a change the system makes. */
  operatorId: string | null;
  role: OperatorRole | null;
}

/**
 * A pre-condition for moving a merchant forward (Task 7 supplies the pilot's). Returns the reasons
 * the move is not allowed yet; empty when it is.
 */
export type RolloutGate = (merchant: Merchant, to: { stage: RolloutStage; canaryPercent: number | null }) => Promise<string[]>;

const ORDER: Record<RolloutStage, number> = { SHADOW: 0, CANARY: 1, FULL: 2 };

/** The mandate's fixed place (0–99) in canary order: the first 32 bits of SHA-256(id), mod 100. */
export function canaryBucket(mandateId: string): number {
  return createHash('sha256').update(mandateId).digest().readUInt32BE(0) % 100;
}

/**
 * Who executes a new debit on this mandate. In CANARY the mandates in buckets below the percentage
 * are Merchantflo's, so raising the percentage only adds mandates and lowering it only removes them.
 */
export function executorFor(m: { rolloutStage: RolloutStage; canaryPercent: number | null }, mandateId: string): Executor {
  if (m.rolloutStage === 'FULL') return 'MERCHANTFLO';
  if (m.rolloutStage === 'SHADOW') return 'MERCHANT';
  return canaryBucket(mandateId) < (m.canaryPercent ?? 0) ? 'MERCHANTFLO' : 'MERCHANT';
}

/** A move towards more Merchantflo execution (a later stage, or a larger canary). */
export function isForward(from: { rolloutStage: RolloutStage; canaryPercent: number | null }, to: { stage: RolloutStage; canaryPercent: number | null }): boolean {
  if (ORDER[to.stage] !== ORDER[from.rolloutStage]) return ORDER[to.stage] > ORDER[from.rolloutStage];
  return (to.canaryPercent ?? 0) > (from.canaryPercent ?? 0);
}

function validTarget(to: RolloutTarget): { stage: RolloutStage; canaryPercent: number | null } {
  if (to.stage !== 'CANARY') {
    if (to.canaryPercent !== undefined && to.canaryPercent !== null) throw new AppError('VALIDATION', 'A canary percentage is set only for CANARY');
    return { stage: to.stage, canaryPercent: null };
  }
  if (to.canaryPercent === undefined || to.canaryPercent === null) throw new AppError('VALIDATION', 'CANARY needs a canary percentage');
  if (!Number.isInteger(to.canaryPercent) || to.canaryPercent < 1 || to.canaryPercent > 99) {
    throw new AppError('VALIDATION', 'The canary percentage must be a whole number between 1 and 99 (use FULL for 100)');
  }
  return { stage: 'CANARY', canaryPercent: to.canaryPercent };
}

export function rolloutChangeView(c: RolloutChange) {
  return {
    id: c.id,
    fromStage: c.fromStage,
    fromPercent: c.fromPercent,
    toStage: c.toStage,
    toPercent: c.toPercent,
    reason: c.reason,
    operatorId: c.operatorId,
    override: c.override,
    createdAt: c.createdAt,
  };
}

/** Record a stage change made inside `tx` (history, audit, merchant webhook). */
async function recordChange(
  tx: DbOrTx,
  operators: OperatorService,
  args: {
    merchant: Merchant;
    to: { stage: RolloutStage; canaryPercent: number | null };
    reason: string;
    operatorId: string | null;
    /** Failed gates an owner overrode (empty: no override). */
    overridden: string[];
    now: Date;
  },
): Promise<Merchant> {
  const { merchant: m, to, now } = args;
  const override = args.overridden.length > 0;
  const [updated] = await tx.update(merchants).set({ rolloutStage: to.stage, canaryPercent: to.canaryPercent }).where(eq(merchants.id, m.id)).returning();
  await tx.insert(rolloutChanges).values({
    id: newId('rlc'),
    merchantId: m.id,
    fromStage: m.rolloutStage,
    fromPercent: m.canaryPercent,
    toStage: to.stage,
    toPercent: to.canaryPercent,
    reason: args.reason,
    operatorId: args.operatorId,
    override,
    createdAt: now,
  });
  await operators.audit(tx, args.operatorId, 'ROLLOUT_CHANGED', m.id, {
    from: m.rolloutStage,
    to: to.stage,
    canaryPercent: to.canaryPercent,
    reason: args.reason,
    ...(override ? { override: true, overridden: args.overridden } : {}),
  });
  // The merchant's integration needs no change (every response says who executes the debit); this
  // tells their team the split moved. Reasons are internal and stay out of it.
  await enqueueWebhook(tx, {
    merchantId: m.id,
    event: 'pilot.stage_changed',
    payload: { stage: to.stage, canaryPercent: to.canaryPercent, previousStage: m.rolloutStage, previousCanaryPercent: m.canaryPercent, changedAt: now.toISOString() },
    now,
  });
  return updated!;
}

/**
 * Live money starts in shadow: a merchant entering LIVE mode with no rollout history moves to
 * SHADOW, so its own billing system and Merchantflo never both execute its debits until an operator
 * says so. Call inside the transaction that sets the mode. Returns the merchant as it now is.
 */
export async function startShadowOnFirstLive(tx: DbOrTx, operators: OperatorService, merchant: Merchant, now: Date): Promise<Merchant> {
  if (merchant.mode !== 'LIVE' || merchant.rolloutStage !== 'FULL') return merchant;
  const [any] = await tx.select({ id: rolloutChanges.id }).from(rolloutChanges).where(eq(rolloutChanges.merchantId, merchant.id)).limit(1);
  if (any) return merchant;
  return recordChange(tx, operators, {
    merchant,
    to: { stage: 'SHADOW', canaryPercent: null },
    reason: 'First switch to live mode: real money starts in shadow',
    operatorId: null,
    overridden: [],
    now,
  });
}

/** A merchant's pilot rollout: stage, history and operator-driven changes behind gates. */
export class RolloutService {
  private gates: RolloutGate[] = [];

  constructor(private readonly deps: { db: Db; clock: Clock; operators: OperatorService }) {}

  /** Add a pre-condition for forward moves. */
  addGate(gate: RolloutGate): void {
    this.gates.push(gate);
  }

  async get(merchantId: string): Promise<{ stage: RolloutStage; canaryPercent: number | null; since: Date | null }> {
    const { db } = this.deps;
    const [m] = await db.select({ stage: merchants.rolloutStage, canaryPercent: merchants.canaryPercent }).from(merchants).where(eq(merchants.id, merchantId));
    if (!m) throw new AppError('NOT_FOUND', `Merchant ${merchantId} not found`);
    const [last] = await db
      .select({ at: rolloutChanges.createdAt })
      .from(rolloutChanges)
      .where(eq(rolloutChanges.merchantId, merchantId))
      .orderBy(desc(rolloutChanges.createdAt))
      .limit(1);
    return { stage: m.stage, canaryPercent: m.canaryPercent, since: last?.at ?? null };
  }

  /** Oldest first. */
  async history(merchantId: string): Promise<RolloutChange[]> {
    return this.deps.db.select().from(rolloutChanges).where(eq(rolloutChanges.merchantId, merchantId)).orderBy(asc(rolloutChanges.createdAt));
  }

  /**
   * The natural next step for a merchant (SHADOW → CANARY at `canaryPercent`, CANARY → FULL) and
   * what blocks it now, without changing anything. Null when the merchant is already FULL.
   */
  async nextStep(merchantId: string, canaryPercent = 5): Promise<{ stage: RolloutStage; canaryPercent: number | null; problems: string[] } | null> {
    const [m] = await this.deps.db.select().from(merchants).where(eq(merchants.id, merchantId));
    if (!m) throw new AppError('NOT_FOUND', `Merchant ${merchantId} not found`);
    if (m.rolloutStage === 'FULL') return null;
    const to = m.rolloutStage === 'SHADOW' ? { stage: 'CANARY' as const, canaryPercent } : { stage: 'FULL' as const, canaryPercent: null };
    return { ...to, problems: await this.problems(m, to) };
  }

  private async problems(m: Merchant, to: { stage: RolloutStage; canaryPercent: number | null }): Promise<string[]> {
    return isForward(m, to) ? (await Promise.all(this.gates.map((g) => g(m, to)))).flat() : [];
  }

  /**
   * Move a merchant to another stage or canary size. Backward moves (the rollback) are always
   * allowed; forward moves must pass every gate unless an OWNER overrides them, with a reason.
   * Affects new debit requests only: debits already accepted keep their executor.
   */
  async change(merchantId: string, input: RolloutTarget & { reason: string; override?: boolean }, actor: RolloutActor): Promise<Merchant> {
    const { db, clock, operators } = this.deps;
    const reason = input.reason.trim();
    if (!reason) throw new AppError('VALIDATION', 'A stage change needs a reason (it is kept in the pilot history)');
    const override = input.override ?? false;
    if (override && actor.role !== 'OWNER') throw new AppError('FORBIDDEN', 'Only an owner can override a pilot gate');
    const to = validTarget(input);

    const [current] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    if (!current) throw new AppError('NOT_FOUND', `Merchant ${merchantId} not found`);
    if (current.rolloutStage === to.stage && current.canaryPercent === to.canaryPercent) {
      throw new AppError('CONFLICT', `Merchant is already ${to.stage}${to.canaryPercent ? ` at ${to.canaryPercent}%` : ''}`);
    }
    // Gates are always evaluated for a forward move, so an override records exactly what it overrode.
    const problems = await this.problems(current, to);
    if (problems.length > 0 && !override) throw new AppError('CONFLICT', `Not ready for ${to.stage}${to.canaryPercent ? ` ${to.canaryPercent}%` : ''}: ${problems.join('; ')}`);

    return db.transaction(async (tx) => {
      const [locked] = await tx.select().from(merchants).where(eq(merchants.id, merchantId)).for('update');
      // Someone else changed it while the gates were checked: decide again on the new state.
      if (!locked || locked.rolloutStage !== current.rolloutStage || locked.canaryPercent !== current.canaryPercent) {
        throw new AppError('CONFLICT', 'The rollout stage changed meanwhile; reload and try again');
      }
      return recordChange(tx, operators, { merchant: locked, to, reason, operatorId: actor.operatorId, overridden: problems, now: clock.now() });
    });
  }
}
