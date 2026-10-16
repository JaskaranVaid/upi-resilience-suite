import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { duplicateSuspects, type DuplicateSide, type DuplicateStatus } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { OperatorService } from '../ops-console/operators.js';

export type DuplicateSuspect = typeof duplicateSuspects.$inferSelect;

export interface DuplicateOptions {
  /** Two successes on one mandate closer than this are a suspected double debit. */
  windowMs: number;
  /** How far back each scan looks (merchants may report their executions days late). */
  lookbackMs: number;
  /** Scan at most this often from the worker. */
  checkEveryMs: number;
}

export const DEFAULT_DUPLICATES: DuplicateOptions = { windowMs: 24 * 3600_000, lookbackMs: 7 * 86_400_000, checkEveryMs: 10 * 60_000 };

export function duplicateView(s: DuplicateSuspect) {
  return {
    id: s.id,
    merchantId: s.merchantId,
    mandateRef: s.mandateRef,
    amountPaise: s.amountPaise,
    first: { kind: s.firstKind, id: s.firstId, at: s.firstAt },
    second: { kind: s.secondKind, id: s.secondId, at: s.secondAt },
    sameOrder: s.sameOrder,
    status: s.status,
    detectedAt: s.detectedAt,
    resolvedAt: s.resolvedAt,
    resolvedBy: s.resolvedBy,
    resolutionNote: s.resolutionNote,
  };
}

type Pair = {
  merchant_id: string; mandate_ref: string; amount_paise: unknown; same_order: boolean;
  a_kind: DuplicateSide; a_id: string; a_at: Date | string; b_kind: DuplicateSide; b_id: string; b_at: Date | string;
};

/**
 * Finds suspected double debits: two successful executions of one mandate, for the same amount,
 * less than 24 hours apart, at least one of them by Merchantflo. Executions come from live debits
 * and from what merchants reported their own systems did (shadow debits, including misroutes).
 * Pairs of the merchant's own executions are its business, not a pilot failure, and are skipped.
 * Every pair is stored once and waits for an operator: CONFIRMED (refund) or DISMISSED (legitimate).
 */
export class DuplicateDetector {
  private readonly opts: DuplicateOptions;
  private lastCheck = 0;

  constructor(private readonly deps: { db: Db; clock: Clock; operators: OperatorService; opts?: Partial<DuplicateOptions> }) {
    this.opts = { ...DEFAULT_DUPLICATES, ...deps.opts };
  }

  /** Throttled scan for the worker loop; returns new suspects. */
  async runDue(): Promise<number> {
    const now = this.deps.clock.now().getTime();
    if (now - this.lastCheck < this.opts.checkEveryMs) return 0;
    this.lastCheck = now;
    return this.scan();
  }

  /** Record every new suspect pair in the look-back window; returns how many were new. */
  async scan(): Promise<number> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const since = new Date(now.getTime() - this.opts.lookbackMs);
    const windowSeconds = this.opts.windowMs / 1000;
    const pairs = (await db.execute(sql`
      with execs as (
        select 'DEBIT' as kind, d.id, d.merchant_id, m.mandate_ref, d.amount_paise, d.order_id,
               coalesce(d.executing_since, d.completed_at) as at
        from debits d join mandates m on m.id = d.mandate_id
        where d.state = 'SUCCEEDED' and coalesce(d.executing_since, d.completed_at) >= ${since}
        union all
        select 'SHADOW', s.id, s.merchant_id, s.mandate_ref, s.amount_paise, s.order_id, s.executed_at
        from shadow_debits s
        where s.outcome = 'SUCCEEDED' and s.executed_at >= ${since}
      )
      select a.merchant_id, a.mandate_ref, a.amount_paise,
             (a.order_id is not null and a.order_id = b.order_id) as same_order,
             a.kind as a_kind, a.id as a_id, a.at as a_at, b.kind as b_kind, b.id as b_id, b.at as b_at
      from execs a
      join execs b on b.merchant_id = a.merchant_id and b.mandate_ref = a.mandate_ref and b.amount_paise = a.amount_paise
        and (a.at, a.id) < (b.at, b.id)
        and b.at - a.at < make_interval(secs => ${windowSeconds})
      where a.kind = 'DEBIT' or b.kind = 'DEBIT'
    `)) as unknown as { rows: Pair[] };
    if (pairs.rows.length === 0) return 0;
    const inserted = await db
      .insert(duplicateSuspects)
      .values(
        pairs.rows.map((p) => ({
          id: newId('dup'),
          merchantId: p.merchant_id,
          mandateRef: p.mandate_ref,
          amountPaise: Number(p.amount_paise),
          firstKind: p.a_kind,
          firstId: p.a_id,
          firstAt: new Date(p.a_at),
          secondKind: p.b_kind,
          secondId: p.b_id,
          secondAt: new Date(p.b_at),
          sameOrder: Boolean(p.same_order),
          detectedAt: now,
        })),
      )
      .onConflictDoNothing({ target: [duplicateSuspects.firstId, duplicateSuspects.secondId] })
      .returning({ id: duplicateSuspects.id });
    return inserted.length;
  }

  /** Newest first. */
  async list(q: { status?: DuplicateStatus; merchantId?: string; limit: number }): Promise<DuplicateSuspect[]> {
    const conds: (SQL | undefined)[] = [q.status ? eq(duplicateSuspects.status, q.status) : undefined, q.merchantId ? eq(duplicateSuspects.merchantId, q.merchantId) : undefined];
    return this.deps.db
      .select()
      .from(duplicateSuspects)
      .where(and(...conds))
      .orderBy(desc(duplicateSuspects.detectedAt), desc(duplicateSuspects.id))
      .limit(q.limit);
  }

  /** An operator's decision on an open suspect, with the note the audit log keeps. */
  async resolve(id: string, input: { resolution: Exclude<DuplicateStatus, 'OPEN'>; note: string }, operatorId: string): Promise<DuplicateSuspect> {
    const { db, clock, operators } = this.deps;
    const note = input.note.trim();
    if (!note) throw new AppError('VALIDATION', 'A resolution needs a note (what was checked, what the merchant did)');
    return db.transaction(async (tx) => {
      const [s] = await tx
        .update(duplicateSuspects)
        .set({ status: input.resolution, resolvedAt: clock.now(), resolvedBy: operatorId, resolutionNote: note })
        .where(and(eq(duplicateSuspects.id, id), eq(duplicateSuspects.status, 'OPEN')))
        .returning();
      if (!s) {
        const [existing] = await tx.select({ status: duplicateSuspects.status }).from(duplicateSuspects).where(eq(duplicateSuspects.id, id));
        throw existing ? new AppError('CONFLICT', `Suspect ${id} was already ${existing.status.toLowerCase()}`) : new AppError('NOT_FOUND', `Suspect ${id} not found`);
      }
      await operators.audit(tx, operatorId, 'DUPLICATE_RESOLVED', id, { resolution: input.resolution, merchantId: s.merchantId, note });
      return s;
    });
  }
}
