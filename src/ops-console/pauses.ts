import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { executionPauses, merchants, pspConnections, type PauseScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { OperatorService } from './operators.js';

export type ExecutionPause = typeof executionPauses.$inferSelect;

export interface PauseState {
  global: boolean;
  merchants: ReadonlySet<string>;
  psps: ReadonlySet<string>;
}

const PROVIDER = 'provider:';

export function pauseView(p: ExecutionPause) {
  return { id: p.id, scope: p.scope, target: p.target, reason: p.reason, createdBy: p.createdBy, createdAt: p.createdAt, liftedAt: p.liftedAt, liftedBy: p.liftedBy };
}

/** Throws EXECUTION_PAUSED (503) when new payments for this merchant must not start. */
export function assertMayStartPayment(state: PauseState, merchantId: string): void {
  if (state.global || state.merchants.has(merchantId)) {
    throw new AppError('EXECUTION_PAUSED', 'Payments are paused by Merchantflo operations; please retry later');
  }
}

/**
 * The kill switch. A pause stops new money movement in its scope — the worker claims no new
 * debits (and sends no notices) for it, payment creation answers 503, and the router skips a
 * paused PSP — while confirmations, status checks, reconciliation and webhooks carry on.
 * Lifting it lets everything that waited continue; nothing is ever cancelled.
 */
export class ExecutionControl {
  constructor(private readonly deps: { db: Db; clock: Clock; operators: OperatorService }) {}

  async pause(input: { scope: PauseScope; target?: string | null; reason: string }, actorId: string | null): Promise<ExecutionPause> {
    const { db, clock, operators } = this.deps;
    const reason = input.reason.trim();
    if (!reason) throw new AppError('VALIDATION', 'A pause needs a reason (it is shown to everyone who sees it)');
    const target = input.scope === 'GLOBAL' ? null : (input.target?.trim() ?? '');
    if (input.scope !== 'GLOBAL' && !target) throw new AppError('VALIDATION', `A ${input.scope} pause needs a target`);
    if (input.scope === 'MERCHANT') {
      const [m] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.id, target!));
      if (!m) throw new AppError('NOT_FOUND', `No merchant ${target}`);
    }
    return db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: executionPauses.id })
        .from(executionPauses)
        .where(and(isNull(executionPauses.liftedAt), eq(executionPauses.scope, input.scope), target === null ? isNull(executionPauses.target) : eq(executionPauses.target, target)));
      if (dup) throw new AppError('CONFLICT', `${input.scope}${target ? ` ${target}` : ''} is already paused (${dup.id})`);
      const [p] = await tx
        .insert(executionPauses)
        .values({ id: newId('pse'), scope: input.scope, target, reason, createdBy: actorId, createdAt: clock.now() })
        .returning();
      await operators.audit(tx, actorId, 'EXECUTION_PAUSED', target ? `${input.scope}:${target}` : input.scope, { pauseId: p!.id, reason });
      return p!;
    });
  }

  async lift(id: string, actorId: string | null): Promise<ExecutionPause> {
    const { db, clock, operators } = this.deps;
    return db.transaction(async (tx) => {
      const [p] = await tx
        .update(executionPauses)
        .set({ liftedAt: clock.now(), liftedBy: actorId })
        .where(and(eq(executionPauses.id, id), isNull(executionPauses.liftedAt)))
        .returning();
      if (!p) {
        const [existing] = await tx.select({ id: executionPauses.id }).from(executionPauses).where(eq(executionPauses.id, id));
        throw existing ? new AppError('CONFLICT', `Pause ${id} was already lifted`) : new AppError('NOT_FOUND', `Pause ${id} not found`);
      }
      await operators.audit(tx, actorId, 'EXECUTION_RESUMED', p.target ? `${p.scope}:${p.target}` : p.scope, { pauseId: p.id });
      return p;
    });
  }

  async active(): Promise<ExecutionPause[]> {
    return this.deps.db.select().from(executionPauses).where(isNull(executionPauses.liftedAt));
  }

  async state(): Promise<PauseState> {
    const pauses = await this.active();
    return {
      global: pauses.some((p) => p.scope === 'GLOBAL'),
      merchants: new Set(pauses.filter((p) => p.scope === 'MERCHANT').map((p) => p.target!)),
      psps: await this.expandPsps(pauses.filter((p) => p.scope === 'PSP').map((p) => p.target!)),
    };
  }

  /** PSP ids (connections and shared adapters) currently paused. */
  async pausedPsps(): Promise<ReadonlySet<string>> {
    return (await this.state()).psps;
  }

  private async expandPsps(targets: string[]): Promise<ReadonlySet<string>> {
    const ids = new Set(targets.filter((t) => !t.startsWith(PROVIDER)));
    const providers = targets.filter((t) => t.startsWith(PROVIDER)).map((t) => t.slice(PROVIDER.length));
    if (providers.length > 0) {
      const conns = await this.deps.db
        .select({ id: pspConnections.id })
        .from(pspConnections)
        .where(inArray(pspConnections.provider, providers as Array<typeof pspConnections.$inferSelect.provider>));
      for (const c of conns) ids.add(c.id);
    }
    return ids;
  }
}
