import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { debits, paymentAttempts, payments, paymentTracking, pspConnections, reconRuns, settlements } from '../db/schema.js';
import { recordEvents, SYSTEM } from '../events/record.js';
import { newId } from '../ids.js';
import type { PspRegistry } from '../psp/registry.js';
import type { SettlementItem } from '../psp/types.js';
import { addIstDays, istDateString, istMidnight, toIst } from '../rules/time.js';
import type { TrackingService } from '../tracking/service.js';
import type { DomainState, SubjectType } from '../tracking/types.js';

export interface ReconOptions {
  /** A capture still unsettled this many days after its day was reconciled opens a NOT_SETTLED case. */
  notSettledAfterDays: number;
  /** How many past days to (re)try when a run is missing or failed. */
  backfillDays: number;
  /** Reconcile yesterday only after this IST time (PSPs publish the previous day's report overnight). */
  runAfterIstMinutes: number;
  /** A RUNNING run older than this is assumed crashed and may be taken over. */
  staleRunMs: number;
  /** Check for due work at most this often. */
  checkEveryMs: number;
}

export const DEFAULT_RECON: ReconOptions = {
  notSettledAfterDays: 3,
  backfillDays: 7,
  runAfterIstMinutes: 6 * 60,
  staleRunMs: 30 * 60_000,
  checkEveryMs: 10 * 60_000,
};

type Subject = { type: SubjectType; id: string; amountPaise: number; domainState: DomainState };

/**
 * Daily settlement reconciliation per PSP connection. PSP reports are stored line by line (once per
 * PSP event, so re-runs change nothing), matched to our payments and debits, and recorded as
 * settlement facts. Settlement data never changes payment state: it only adds facts and cases.
 */
export class SettlementReconciler {
  private readonly opts: ReconOptions;
  private lastCheck = 0;

  constructor(private readonly deps: { db: Db; clock: Clock; psps: PspRegistry; tracking: TrackingService; opts?: Partial<ReconOptions>; log?: (m: string) => void }) {
    this.opts = { ...DEFAULT_RECON, ...deps.opts };
  }

  /** Reconcile every due (connection, day), then flag long-unsettled captures. Throttled; returns runs done. */
  async runDue(): Promise<number> {
    const { db, clock } = this.deps;
    const now = clock.now();
    if (now.getTime() - this.lastCheck < this.opts.checkEveryMs) return 0;
    this.lastCheck = now.getTime();
    const today = istDateString(now);
    const newestDay = toIst(now).minutes >= this.opts.runAfterIstMinutes ? addIstDays(today, -1) : addIstDays(today, -2);
    const connections = await db.select({ id: pspConnections.id, merchantId: pspConnections.merchantId }).from(pspConnections).where(eq(pspConnections.status, 'ACTIVE'));
    let runs = 0;
    for (const c of connections) {
      let adapter;
      try {
        adapter = await this.deps.psps.get(c.id);
      } catch {
        continue;
      }
      if (!adapter.settlements) continue;
      const done = new Set(
        (await db.select({ day: reconRuns.day }).from(reconRuns).where(and(eq(reconRuns.pspId, c.id), eq(reconRuns.status, 'DONE')))).map((r) => r.day),
      );
      for (let i = this.opts.backfillDays - 1; i >= 0; i--) {
        const day = addIstDays(newestDay, -i);
        if (done.has(day)) continue;
        if (await this.reconcile(c.merchantId, c.id, day)) runs++;
      }
    }
    await this.flagUnsettled();
    return runs;
  }

  /** Reconcile one connection for one IST day. Null if another process holds (or finished) it. */
  async reconcile(merchantId: string, pspId: string, day: string): Promise<{ items: number; matched: number } | null> {
    const { db, clock } = this.deps;
    const now = clock.now();
    const [run] = await db
      .insert(reconRuns)
      .values({ id: newId('rcn'), merchantId, pspId, day, status: 'RUNNING', startedAt: now })
      .onConflictDoUpdate({
        target: [reconRuns.pspId, reconRuns.day],
        set: { status: 'RUNNING', startedAt: now, error: null },
        setWhere: or(eq(reconRuns.status, 'FAILED'), and(eq(reconRuns.status, 'RUNNING'), lt(reconRuns.startedAt, new Date(now.getTime() - this.opts.staleRunMs)))),
      })
      .returning();
    if (!run) return null;

    try {
      const adapter = await this.deps.psps.get(pspId);
      const lines = await adapter.settlements!({ from: istMidnight(day), to: istMidnight(addIstDays(day, 1)) });
      let matched = 0;
      for (const line of lines) if (await this.record(merchantId, pspId, line)) matched++;
      await db.update(reconRuns).set({ status: 'DONE', items: lines.length, matched, finishedAt: clock.now() }).where(eq(reconRuns.id, run.id));
      return { items: lines.length, matched };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      (this.deps.log ?? ((m) => console.error(m)))(`settlement reconciliation ${pspId} ${day} failed: ${error}`);
      await db.update(reconRuns).set({ status: 'FAILED', error, finishedAt: clock.now() }).where(eq(reconRuns.id, run.id));
      return { items: 0, matched: 0 };
    }
  }

  /** Store a line (once) and match it; true if it belongs to one of our payments. */
  private async record(merchantId: string, pspId: string, line: SettlementItem): Promise<boolean> {
    const { db } = this.deps;
    await db
      .insert(settlements)
      .values({
        id: newId('stl'),
        merchantId,
        pspId,
        pspEventId: line.pspEventId,
        kind: line.kind,
        pspPaymentId: line.pspPaymentId,
        orderRef: line.orderRef,
        amountPaise: line.amountPaise,
        feePaise: line.feePaise,
        taxPaise: line.taxPaise,
        settledAmountPaise: line.settledAmountPaise,
        settlementId: line.settlementId,
        utr: line.utr,
        settledAt: line.settledAt,
        createdAt: this.deps.clock.now(),
      })
      .onConflictDoNothing({ target: [settlements.pspId, settlements.pspEventId] });
    const [row] = await db.select().from(settlements).where(and(eq(settlements.pspId, pspId), eq(settlements.pspEventId, line.pspEventId)));
    if (!row) return false;
    if (row.subjectId) return true; // matched on an earlier run
    const subject = await this.findSubject(merchantId, pspId, line);
    if (!subject) return false;
    await db.update(settlements).set({ subjectType: subject.type, subjectId: subject.id }).where(eq(settlements.id, row.id));
    if (line.kind === 'PAYMENT') await this.applyToPayment(merchantId, subject, line);
    return true;
  }

  /** Our payment for a line: by the PSP's payment id, else by our reference on an attempt. */
  private async findSubject(merchantId: string, pspId: string, line: SettlementItem): Promise<Subject | null> {
    const { db } = this.deps;
    if (line.pspPaymentId) {
      const [p] = await db.select().from(payments).where(and(eq(payments.merchantId, merchantId), eq(payments.pspId, pspId), eq(payments.pspTxnId, line.pspPaymentId)));
      if (p) return { type: 'COLLECT', id: p.id, amountPaise: p.amountPaise, domainState: p.state };
      const [d] = await db.select().from(debits).where(and(eq(debits.merchantId, merchantId), eq(debits.pspTxnId, line.pspPaymentId)));
      if (d) return { type: 'AUTOPAY', id: d.id, amountPaise: d.amountPaise, domainState: d.state === 'SUCCEEDED' || d.state === 'FAILED' ? d.state : 'PENDING' };
    }
    if (line.orderRef) {
      const [a] = await db
        .select({ paymentId: paymentAttempts.paymentId, debitId: paymentAttempts.debitId })
        .from(paymentAttempts)
        .where(and(eq(paymentAttempts.merchantId, merchantId), eq(paymentAttempts.pspId, pspId), eq(paymentAttempts.txnRef, line.orderRef)))
        .limit(1);
      if (a?.paymentId) {
        const [p] = await db.select().from(payments).where(eq(payments.id, a.paymentId));
        if (p) return { type: 'COLLECT', id: p.id, amountPaise: p.amountPaise, domainState: p.state };
      }
      if (a?.debitId) {
        const [d] = await db.select().from(debits).where(eq(debits.id, a.debitId));
        if (d) return { type: 'AUTOPAY', id: d.id, amountPaise: d.amountPaise, domainState: d.state === 'SUCCEEDED' || d.state === 'FAILED' ? d.state : 'PENDING' };
      }
    }
    return null;
  }

  /** Record settlement facts on the payment; a different amount than captured is a mismatch case. */
  private async applyToPayment(merchantId: string, subject: Subject, line: SettlementItem): Promise<void> {
    const { db, clock, tracking } = this.deps;
    const now = clock.now();
    const mismatch = line.amountPaise !== subject.amountPaise;
    await db.transaction(async (tx) => {
      const [t] = await tx
        .update(paymentTracking)
        .set({
          settlementStatus: mismatch ? 'MISMATCH' : 'SETTLED',
          settledAt: line.settledAt ?? now,
          settlementUtr: line.utr,
          settledAmountPaise: line.settledAmountPaise,
          settlementFeePaise: line.feePaise + line.taxPaise,
          updatedAt: now,
        })
        .where(and(eq(paymentTracking.subjectType, subject.type), eq(paymentTracking.subjectId, subject.id)))
        .returning();
      if (!t) return;
      await recordEvents(tx, { merchantId, subjectType: subject.type, subjectId: subject.id, actor: SYSTEM, now }, [
        { type: 'SETTLEMENT_RECORDED', data: { utr: line.utr, settledAmountPaise: line.settledAmountPaise, mismatch } },
      ]);
      await tracking.reconcileCase(tx, t, subject.domainState, false, now, undefined, mismatch ? 'SETTLEMENT_MISMATCH' : undefined);
    });
  }

  /**
   * Captured payments still unsettled `notSettledAfterDays` after a reconciled day: open NOT_SETTLED
   * cases. Only for connections whose report was actually read for that later day.
   */
  async flagUnsettled(): Promise<number> {
    const { db, clock, tracking } = this.deps;
    const now = clock.now();
    const rows = (await db.execute(sql`
      select t.id, v.domain_state
      from payment_tracking t
      join merchant_payments_v v on v.subject_type = t.subject_type and v.id = t.subject_id
      where v.domain_state = 'SUCCEEDED' and t.capture = 'CAPTURED' and t.settlement_status = 'UNSETTLED'
        and not exists (select 1 from payment_cases c where c.subject_type = t.subject_type and c.subject_id = t.subject_id and c.status <> 'RESOLVED')
        and exists (
          select 1 from recon_runs r
          where r.psp_id = t.psp_id and r.status = 'DONE'
            and r.day >= to_char((v.last_updated_at at time zone 'Asia/Kolkata') + make_interval(days => ${this.opts.notSettledAfterDays}), 'YYYY-MM-DD')
        )
      limit 500
    `)) as unknown as { rows: Array<{ id: string; domain_state: DomainState }> };
    let opened = 0;
    for (const r of rows.rows) {
      await db.transaction(async (tx) => {
        const [t] = await tx.select().from(paymentTracking).where(eq(paymentTracking.id, r.id));
        if (!t) return;
        if (await tracking.reconcileCase(tx, t, r.domain_state, false, now, undefined, 'NOT_SETTLED')) opened++;
      });
    }
    return opened;
  }
}

/** Unmatched lines and totals for a merchant's settlement view. */
export async function unmatchedCount(db: Db, merchantId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(settlements).where(and(eq(settlements.merchantId, merchantId), isNull(settlements.subjectId), ne(settlements.kind, 'ADJUSTMENT')));
  return Number(r?.n ?? 0);
}
