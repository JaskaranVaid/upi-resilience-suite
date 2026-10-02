import { and, asc, eq, inArray, lt, lte, ne, or } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import { getRuleSet } from '../config/rules.js';
import type { Db } from '../db/client.js';
import { debits, mandates, paymentAttempts, type DebitState } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import { recordSavings } from '../ledger/savings.js';
import type { PspResult } from '../psp/types.js';
import type { AttemptRecord, Router } from '../routing/router.js';
import { istDateString } from '../rules/time.js';
import { isRestricted } from '../rules/windows.js';
import { recordEvents, SYSTEM } from '../events/record.js';
import type { InitialOutcome, TrackingService } from '../tracking/service.js';
import { enqueueWebhook } from '../webhooks/outbox.js';
import { DEFAULT_PLANNING, plan, sendNotice, type PlanningOptions } from './planning.js';
import { debitView, type Debit } from './service.js';

type Mandate = typeof mandates.$inferSelect;

export interface WorkerOptions extends PlanningOptions {
  batchSize: number;
  /** Minimum gap before retrying a technically-declined debit. */
  retryGapMs: number;
  /** An EXECUTING row untouched this long is assumed orphaned by a crashed worker. */
  executingTimeoutMs: number;
  pendingRecheckMs: number;
  /** Give up on a PENDING debit after this long and hand it to ops. */
  maxPendingMs: number;
  noticeRetryMs: number;
}

export const DEFAULT_WORKER: WorkerOptions = {
  ...DEFAULT_PLANNING,
  batchSize: 25,
  retryGapMs: 30 * 60_000,
  executingTimeoutMs: 5 * 60_000,
  pendingRecheckMs: 5 * 60_000,
  maxPendingMs: 48 * 3600_000,
  noticeRetryMs: 15 * 60_000,
};

/**
 * Engine A executor. Postgres is the queue: due rows are claimed with
 * FOR UPDATE SKIP LOCKED, so any number of workers can run safely.
 */
export class DebitWorker {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly router: Router;
  private readonly opts: WorkerOptions;
  private readonly log: (msg: string, err?: unknown) => void;
  /** Phase 3 hook: records money facts and starts verification watches. Optional so Engine A runs standalone. */
  private readonly tracking: TrackingService | undefined;

  constructor(deps: {
    db: Db;
    clock: Clock;
    router: Router;
    tracking?: TrackingService;
    opts?: Partial<WorkerOptions>;
    log?: (msg: string, err?: unknown) => void;
  }) {
    this.db = deps.db;
    this.tracking = deps.tracking;
    this.clock = deps.clock;
    this.router = deps.router;
    this.opts = { ...DEFAULT_WORKER, ...deps.opts };
    this.log = deps.log ?? ((msg, err) => console.error(msg, err));
  }

  /** Process every due debit once. Returns how many were claimed. */
  async runOnce(): Promise<number> {
    const claimed = await this.claim();
    for (const { debit, prev } of claimed) {
      try {
        if (prev === 'SCHEDULED') await this.execute(debit);
        else await this.confirm(debit);
      } catch (e) {
        // Row stays EXECUTING; the stale-lease sweep will reconcile it via status, never a blind retry.
        this.log(`debit ${debit.id} processing failed`, e);
      }
    }
    return claimed.length;
  }

  private async claim(): Promise<Array<{ debit: Debit; prev: DebitState }>> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - this.opts.executingTimeoutMs);
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(debits)
        .where(
          or(
            and(inArray(debits.state, ['SCHEDULED', 'PENDING_CONFIRMATION']), lte(debits.scheduledAt, now)),
            and(eq(debits.state, 'EXECUTING'), lt(debits.updatedAt, staleBefore)),
          ),
        )
        .orderBy(asc(debits.scheduledAt))
        .limit(this.opts.batchSize)
        .for('update', { skipLocked: true });
      for (const r of rows) {
        await tx
          .update(debits)
          .set({
            state: 'EXECUTING',
            updatedAt: now,
            executingSince: r.state === 'SCHEDULED' ? now : (r.executingSince ?? now),
          })
          .where(eq(debits.id, r.id));
      }
      return rows.map((debit) => ({ debit, prev: debit.state }));
    });
  }

  private async execute(d: Debit): Promise<void> {
    const now = this.clock.now();
    const mandate = await this.mandate(d.mandateId);
    if (!mandate || mandate.status !== 'ACTIVE') return this.fail(d, 'MANDATE_INACTIVE', { kind: 'NOT_SUBMITTED' }, null, null);

    // Guardrails: never debit inside a restricted window or on a date the customer wasn't notified of.
    if (isRestricted(now, getRuleSet(now).windows) || istDateString(now) !== d.noticeDate) {
      return this.reschedule(d, mandate, now, null);
    }

    const attempt = d.attempts + 1;
    const baseRef = `${d.id}-a${attempt}`;
    // Persist the txnRef base before touching the PSP so a crash can be reconciled by status lookup.
    await this.db.update(debits).set({ attempts: attempt, lastTxnRef: baseRef, lastPspId: null, updatedAt: now }).where(eq(debits.id, d.id));
    const current = { ...d, attempts: attempt, lastTxnRef: baseRef, lastPspId: null };

    const outcome = await this.router.execute({
      op: 'mandate',
      candidates: mandate.eligiblePsps,
      amountPaise: d.amountPaise,
      mandateRef: mandate.mandateRef,
      noticeRef: d.id,
      baseRef,
    });
    await this.recordAttempts(d, outcome.attempts);
    await recordEvents(this.db, { merchantId: d.merchantId, subjectType: 'AUTOPAY', subjectId: d.id, actor: SYSTEM, now: this.clock.now() }, [
      { type: 'PAYMENT_SUBMITTED', data: { pspId: outcome.pspId ?? null, attempt, attempts: outcome.attempts.length } },
    ]);
    await this.handle(current, mandate, outcome.result, outcome.pspId ?? null, outcome.txnRef ?? null);
  }

  /** Resolve a PENDING or orphaned debit purely by status lookups. */
  private async confirm(d: Debit): Promise<void> {
    const mandate = await this.mandate(d.mandateId);
    if (!mandate) return this.fail(d, 'MANDATE_INACTIVE', { kind: 'NOT_SUBMITTED' }, null, null);
    if (!d.lastTxnRef) return this.execute(d); // crashed before any PSP call

    const records: AttemptRecord[] = [];
    let found: { result: PspResult; pspId: string; txnRef: string } | null = null;
    const probes: Array<[string, string]> = d.lastPspId
      ? [[d.lastPspId, d.lastTxnRef]]
      : mandate.eligiblePsps.flatMap((psp) => mandate.eligiblePsps.map((_, i): [string, string] => [psp, `${d.lastTxnRef}-${i + 1}`]));

    for (const [pspId, txnRef] of probes) {
      const t0 = this.clock.now().getTime();
      let result: PspResult;
      try {
        result = await this.router.status(pspId, txnRef, { kind: 'MANDATE', mandateRef: mandate.mandateRef, noticeRef: d.id });
      } catch {
        result = { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };
      }
      records.push({ pspId, txnRef, op: 'status', result, latencyMs: this.clock.now().getTime() - t0 });
      if (result.kind === 'SUCCESS') {
        found = { result, pspId, txnRef };
        break;
      }
      if ((result.kind === 'PENDING' || result.kind === 'BUSINESS_DECLINE') && !found) found = { result, pspId, txnRef };
      if (result.kind === 'TECHNICAL_DECLINE' && !found) {
        // Can't tell what happened at this PSP — treat as still pending rather than risk a double debit.
        found = { result: { kind: 'PENDING' }, pspId, txnRef };
      }
    }
    await this.recordAttempts(d, records);
    const r = found ?? { result: { kind: 'NOT_FOUND' } as PspResult, pspId: null, txnRef: null };
    await this.handle(d, mandate, r.result, r.pspId, r.txnRef);
  }

  private async handle(d: Debit, mandate: Mandate, result: PspResult, pspId: string | null, txnRef: string | null): Promise<void> {
    const now = this.clock.now();
    switch (result.kind) {
      case 'SUCCESS':
        return this.succeed(d, result.pspTxnId, pspId, txnRef, result.upiRrn);
      case 'BUSINESS_DECLINE':
        return this.fail(d, result.code, { kind: 'FAILED_BUSINESS' }, pspId, txnRef);
      case 'PENDING': {
        const since = d.executingSince ?? now;
        if (now.getTime() - since.getTime() >= this.opts.maxPendingMs) return this.fail(d, 'UNRESOLVED_PENDING', { kind: 'UNRESOLVED' }, pspId ?? d.lastPspId, txnRef ?? d.lastTxnRef);
        await this.db
          .update(debits)
          .set({
            state: 'PENDING_CONFIRMATION',
            lastPspId: pspId,
            lastTxnRef: txnRef ?? d.lastTxnRef,
            scheduledAt: new Date(now.getTime() + this.opts.pendingRecheckMs),
            updatedAt: now,
          })
          .where(eq(debits.id, d.id));
        return;
      }
      case 'TECHNICAL_DECLINE':
      case 'NOT_FOUND': {
        const code = result.kind === 'TECHNICAL_DECLINE' ? result.code : 'NOT_FOUND';
        if (d.attempts >= d.maxAttempts) return this.fail(d, code, { kind: 'FAILED_TECHNICAL' }, pspId, txnRef);
        return this.reschedule(d, mandate, new Date(now.getTime() + this.opts.retryGapMs), code);
      }
    }
  }

  private async reschedule(d: Debit, mandate: Mandate, earliest: Date, errorCode: string | null): Promise<void> {
    const now = this.clock.now();
    const p = plan({ earliest, now, seed: `${d.id}:${d.attempts}`, noticeDate: d.noticeDate, opts: this.opts });
    let noticeSentAt = d.noticeSentAt;
    if (p.needsNotice) {
      try {
        await sendNotice(this.router, mandate, d.id, d.amountPaise, p.noticeDate);
        noticeSentAt = now;
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        await this.db
          .update(debits)
          .set({ state: 'SCHEDULED', scheduledAt: new Date(now.getTime() + this.opts.noticeRetryMs), lastErrorCode: 'NOTICE_FAILED', updatedAt: now })
          .where(eq(debits.id, d.id));
        return;
      }
    }
    await this.db
      .update(debits)
      .set({
        state: 'SCHEDULED',
        scheduledAt: p.scheduledAt,
        noticeDate: p.noticeDate,
        noticeSentAt,
        executingSince: null,
        lastPspId: null,
        updatedAt: now,
        ...(errorCode ? { lastErrorCode: errorCode } : {}),
      })
      .where(eq(debits.id, d.id));
  }

  private async succeed(d: Debit, pspTxnId: string, pspId: string | null, txnRef: string | null, upiRrn?: string): Promise<void> {
    const now = this.clock.now();
    const hadTechnicalDecline =
      (
        await this.db
          .select({ id: paymentAttempts.id })
          .from(paymentAttempts)
          .where(and(eq(paymentAttempts.debitId, d.id), eq(paymentAttempts.outcome, 'TECHNICAL_DECLINE'), ne(paymentAttempts.op, 'status'), eq(paymentAttempts.probe, false)))
          .limit(1)
      ).length > 0;

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(debits)
        .set({ state: 'SUCCEEDED', pspTxnId, completedAt: now, lastErrorCode: null, updatedAt: now })
        .where(eq(debits.id, d.id))
        .returning();
      await enqueueWebhook(tx, { merchantId: d.merchantId, event: 'debit.succeeded', payload: debitView(row!), now });
      // One attribution per rescued debit so revenue-protected totals never double count.
      const type = d.requestedInPeak ? 'PEAK_DEFERRAL_RESCUED' : hadTechnicalDecline ? 'TD_RECOVERED' : null;
      if (type) await recordSavings(tx, { merchantId: d.merchantId, type, amountPaise: d.amountPaise, refId: d.id, now });
      await this.afterOutcome(tx, d, 'SUCCEEDED', { kind: 'SUCCEEDED', ...(upiRrn ? { upiRrn } : {}) }, pspId, txnRef, now);
    });
  }

  private async fail(d: Debit, code: string, outcome: InitialOutcome, pspId: string | null, txnRef: string | null): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(debits)
        .set({ state: 'FAILED', lastErrorCode: code, completedAt: now, updatedAt: now })
        .where(eq(debits.id, d.id))
        .returning();
      await enqueueWebhook(tx, { merchantId: d.merchantId, event: 'debit.failed', payload: debitView(row!), now });
      await this.afterOutcome(tx, d, 'FAILED', outcome, pspId, txnRef, now);
    });
  }

  /** Audit + Phase 3 tracking for a terminal debit, inside the same transaction as the state change. */
  private async afterOutcome(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    d: Debit,
    to: 'SUCCEEDED' | 'FAILED',
    outcome: InitialOutcome,
    pspId: string | null,
    txnRef: string | null,
    now: Date,
  ): Promise<void> {
    await recordEvents(tx, { merchantId: d.merchantId, subjectType: 'AUTOPAY', subjectId: d.id, actor: SYSTEM, now }, [
      { type: 'PAYMENT_STATE_CHANGED', data: { to } },
    ]);
    await this.tracking?.recordOutcome(tx, { merchantId: d.merchantId, subjectType: 'AUTOPAY', subjectId: d.id, pspId, txnRef, outcome, now });
  }

  private async mandate(id: string): Promise<Mandate | undefined> {
    const [m] = await this.db.select().from(mandates).where(eq(mandates.id, id));
    return m;
  }

  private async recordAttempts(d: Debit, records: AttemptRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.insert(paymentAttempts).values(
      records.map((a, seq) => ({
        id: newId('att'),
        merchantId: d.merchantId,
        debitId: d.id,
        pspId: a.pspId,
        txnRef: a.txnRef,
        op: a.op,
        outcome: a.result.kind,
        code: 'code' in a.result ? a.result.code : null,
        latencyMs: a.latencyMs,
        seq,
        probe: a.probe ?? false,
        createdAt: this.clock.now(),
      })),
    );
  }
}
