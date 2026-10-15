import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { PollingConfig } from '../config/polling.js';
import type { Db, DbOrTx } from '../db/client.js';
import { debits, mandates, paymentAttempts, paymentCases, payments, paymentTracking, udirComplaints } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents, SYSTEM, type Actor } from '../events/record.js';
import { newId } from '../ids.js';
import { applyPaymentOutcome } from '../payments/outcome.js';
import { enqueueWebhook, type WebhookEvent } from '../webhooks/outbox.js';
import { paymentFactsPayload } from '../webhooks/payloads.js';
import type { PspRegistry } from '../psp/registry.js';
import type { ComplaintStatus, PspResult, TransactionInquiry, TxnContext } from '../psp/types.js';
import { caseResolution, caseStatus } from './derive.js';
import { reduce } from './reduce.js';
import { nextCheckAt } from './schedule.js';
import type { CaseReason, DomainState, MoneyFacts, NewEvent, SubjectType, VerificationStatus } from './types.js';

export type Tracking = typeof paymentTracking.$inferSelect;
export type PaymentCase = typeof paymentCases.$inferSelect;

/** How a payment left the router/worker, as far as tracking is concerned. */
export type InitialOutcome =
  | { kind: 'SUCCEEDED'; upiRrn?: string }
  | { kind: 'PENDING' }
  /** Infrastructure failure: the customer may still have been debited — watch it. */
  | { kind: 'FAILED_TECHNICAL' }
  /** Customer-side decline: definitively not debited. */
  | { kind: 'FAILED_BUSINESS' }
  /** Phase 1 worker already spent its pending budget without an answer. */
  | { kind: 'UNRESOLVED' }
  /** Never reached a PSP (e.g. mandate inactive). */
  | { kind: 'NOT_SUBMITTED' };

export interface CheckResult {
  tracking: Tracking;
  case: PaymentCase | null;
}

const RESOLVED_COMPLAINT: ReadonlySet<ComplaintStatus> = new Set(['RESOLVED_REVERSED', 'RESOLVED_NO_REVERSAL', 'REJECTED']);

function factsOf(t: Tracking): MoneyFacts {
  return {
    customerDebit: t.customerDebit,
    capture: t.capture,
    reversalStatus: t.reversalStatus,
    reversalInitiatedAt: t.reversalInitiatedAt,
    reversalCompletedAt: t.reversalCompletedAt,
    upiRrn: t.upiRrn,
    npciTxnId: t.npciTxnId,
  };
}

/**
 * Owns money-movement facts, the verification lifecycle and case reconciliation for every
 * payment. The only writer of payment_tracking and payment_cases (complaints and notes are
 * DisputeService's). All decisions are made by pure functions in reduce.ts / derive.ts.
 */
export class TrackingService {
  constructor(private readonly deps: { db: Db; clock: Clock; psps: PspRegistry; cfg: PollingConfig }) {}

  get config(): PollingConfig {
    return this.deps.cfg;
  }

  /** Record how a payment left the router or worker, and start watching it if needed. */
  async recordOutcome(
    tx: DbOrTx,
    args: { merchantId: string; subjectType: SubjectType; subjectId: string; pspId: string | null; txnRef: string | null; outcome: InitialOutcome; now: Date },
  ): Promise<Tracking> {
    const { merchantId, subjectType, subjectId, pspId, txnRef, outcome, now } = args;
    const base = { customerDebit: 'UNKNOWN', capture: 'UNKNOWN', verificationStatus: 'NOT_REQUIRED' } as const;
    let values: Partial<typeof paymentTracking.$inferInsert> & { verificationStatus: VerificationStatus } = { ...base };
    const events: NewEvent[] = [];

    switch (outcome.kind) {
      case 'SUCCEEDED':
        values = { ...base, customerDebit: 'DEBITED', capture: 'CAPTURED', upiRrn: outcome.upiRrn ?? null };
        break;
      case 'FAILED_BUSINESS':
        values = { ...base, customerDebit: 'NOT_DEBITED', capture: 'NOT_CAPTURED' };
        break;
      case 'PENDING':
      case 'FAILED_TECHNICAL':
        values = { ...base, verificationStatus: 'IN_PROGRESS', verificationStartedAt: now, nextCheckAt: nextCheckAt(now, now, this.deps.cfg) };
        events.push({ type: 'VERIFICATION_STARTED' });
        break;
      case 'UNRESOLVED':
        values = { ...base, verificationStatus: 'NEEDS_MANUAL_INVESTIGATION', verificationStartedAt: now };
        events.push({ type: 'VERIFICATION_EXHAUSTED' });
        break;
      case 'NOT_SUBMITTED':
        break;
    }

    const [row] = await tx
      .insert(paymentTracking)
      .values({ id: newId('trk'), merchantId, subjectType, subjectId, pspId, txnRef, ...values, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [paymentTracking.subjectType, paymentTracking.subjectId],
        set: { pspId, txnRef, ...values, leaseUntil: null, updatedAt: now },
      })
      .returning();
    const tracking = row!;
    const ctx = { merchantId, subjectType, subjectId, actor: SYSTEM, now };
    await recordEvents(tx, ctx, events);
    if (outcome.kind === 'UNRESOLVED') await this.reconcileCase(tx, tracking, 'FAILED', false, now);
    return tracking;
  }

  async getBySubject(db: DbOrTx, subjectType: SubjectType, subjectId: string): Promise<Tracking | undefined> {
    const [t] = await db
      .select()
      .from(paymentTracking)
      .where(and(eq(paymentTracking.subjectType, subjectType), eq(paymentTracking.subjectId, subjectId)));
    return t;
  }

  /** Restart the watch (fresh budget), e.g. after a UDIR complaint is raised. */
  async restartWatch(tx: DbOrTx, trackingId: string, now: Date): Promise<void> {
    await tx
      .update(paymentTracking)
      .set({ verificationStatus: 'IN_PROGRESS', verificationStartedAt: now, nextCheckAt: nextCheckAt(now, now, this.deps.cfg), updatedAt: now })
      .where(eq(paymentTracking.id, trackingId));
  }

  /**
   * Perform one status check. Exclusive per payment via a lease, so the poller and a manual
   * "Recheck now" can never query the PSP for the same payment at the same time.
   * Returns null if another check holds the lease (poller); manual callers get CHECK_IN_PROGRESS.
   */
  async check(trackingId: string, actor: Actor, opts: { manual: boolean }): Promise<CheckResult | null> {
    const { db, clock, cfg } = this.deps;
    const now = clock.now();

    if (opts.manual) {
      const [current] = await db.select().from(paymentTracking).where(eq(paymentTracking.id, trackingId));
      if (!current) throw new AppError('NOT_FOUND', 'Payment tracking not found');
      if (current.lastManualCheckAt && now.getTime() - current.lastManualCheckAt.getTime() < cfg.manualRecheckCooldownMs) {
        throw new AppError('RECHECK_TOO_SOON', 'This payment was rechecked moments ago — try again shortly');
      }
    }

    const [claimed] = await db
      .update(paymentTracking)
      .set({ leaseUntil: new Date(now.getTime() + cfg.leaseMs) })
      .where(and(eq(paymentTracking.id, trackingId), or(isNull(paymentTracking.leaseUntil), lt(paymentTracking.leaseUntil, now))))
      .returning();
    if (!claimed) {
      if (opts.manual) throw new AppError('CHECK_IN_PROGRESS', 'A status check for this payment is already running');
      return null;
    }

    try {
      return await this.runCheck(claimed, actor, opts.manual);
    } catch (e) {
      await db.update(paymentTracking).set({ leaseUntil: null }).where(eq(paymentTracking.id, trackingId));
      throw e;
    }
  }

  private async runCheck(t: Tracking, actor: Actor, manual: boolean): Promise<CheckResult> {
    const { db, clock, cfg, psps } = this.deps;
    const domainState = await this.domainState(t.subjectType, t.subjectId);

    let inquiry: TransactionInquiry | { error: string };
    if (!t.pspId || !t.txnRef) {
      inquiry = { error: 'no PSP reference recorded' };
    } else {
      try {
        inquiry = await (await psps.get(t.pspId)).inquire(t.txnRef, await this.txnContext(t));
      } catch (e) {
        inquiry = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    const openCase = await this.openCase(db, t.subjectType, t.subjectId);
    const complaint = openCase ? await this.latestComplaint(db, openCase.id) : undefined;
    let complaintStatus: ComplaintStatus | null = complaint?.status ?? null;
    let complaintChanged = false;
    if (complaint && !RESOLVED_COMPLAINT.has(complaint.status)) {
      try {
        const s = await (await psps.get(complaint.pspId)).complaintStatus(complaint.pspComplaintRef);
        if (s.ok && s.status !== complaint.status) {
          complaintStatus = s.status;
          complaintChanged = true;
        }
      } catch {
        // Complaint status is refreshed again on the next check.
      }
    }

    const now = clock.now();
    const out = reduce({
      subjectType: t.subjectType,
      domainState,
      retryOpenUntil: await this.retryOpenUntil(t),
      facts: factsOf(t),
      verificationStatus: t.verificationStatus,
      verificationStartedAt: t.verificationStartedAt,
      inquiry,
      now,
      cfg,
    });
    // A resolved complaint ends the watch even if the PSP enquiry is still inconclusive.
    const complaintDone = complaintStatus !== null && RESOLVED_COMPLAINT.has(complaintStatus) && complaintStatus !== 'REJECTED';
    const verificationStatus = complaintDone && out.verificationStatus === 'IN_PROGRESS' ? 'RESOLVED' : out.verificationStatus;
    // The PSP resolving a UDIR complaint as "reversed" is an observed reversal: record it, so
    // the money panel, merchant status and customer status all agree with the complaint.
    if (complaintStatus === 'RESOLVED_REVERSED' && out.facts.reversalStatus !== 'COMPLETED') {
      if (out.facts.reversalStatus !== 'INITIATED') out.events.push({ type: 'REVERSAL_INITIATED' });
      out.events.push({ type: 'REVERSAL_COMPLETED', data: { via: 'UDIR_COMPLAINT' } });
      out.facts = { ...out.facts, reversalStatus: 'COMPLETED', reversalInitiatedAt: out.facts.reversalInitiatedAt ?? now, reversalCompletedAt: now };
    }

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(paymentTracking)
        .set({
          customerDebit: out.facts.customerDebit,
          capture: out.facts.capture,
          reversalStatus: out.facts.reversalStatus,
          reversalInitiatedAt: out.facts.reversalInitiatedAt,
          reversalCompletedAt: out.facts.reversalCompletedAt,
          upiRrn: out.facts.upiRrn,
          npciTxnId: out.facts.npciTxnId,
          verificationStatus,
          nextCheckAt: verificationStatus === 'IN_PROGRESS' ? out.nextCheckAt : null,
          checkCount: sql`${paymentTracking.checkCount} + 1`,
          lastCheckedAt: now,
          ...(manual ? { lastManualCheckAt: now } : {}),
          leaseUntil: null,
          updatedAt: now,
        })
        .where(eq(paymentTracking.id, t.id))
        .returning();
      const tracking = updated!;
      const ctx = { merchantId: t.merchantId, subjectType: t.subjectType, subjectId: t.subjectId, actor: SYSTEM, now };

      if (manual) await recordEvents(tx, { ...ctx, actor }, [{ type: 'RECHECK_REQUESTED' }]);
      await recordEvents(tx, ctx, out.events);

      let domainAfter = domainState;
      if (out.domainOutcome && t.subjectType === 'COLLECT') {
        // Credit routing recovery if any earlier attempt on this payment was a technical decline.
        const [td] = await tx
          .select({ id: paymentAttempts.id })
          .from(paymentAttempts)
          .where(and(eq(paymentAttempts.paymentId, t.subjectId), eq(paymentAttempts.outcome, 'TECHNICAL_DECLINE'), ne(paymentAttempts.op, 'status'), eq(paymentAttempts.probe, false)))
          .limit(1);
        const result: PspResult =
          out.domainOutcome.to === 'SUCCEEDED'
            ? {
                kind: 'SUCCESS',
                // The PSP's payment id when it gives one: settlement reports match on it.
                pspTxnId: ('found' in inquiry && inquiry.found && inquiry.pspPaymentId) || (out.facts.npciTxnId ?? out.facts.upiRrn ?? t.txnRef ?? t.subjectId),
              }
            : { kind: 'BUSINESS_DECLINE', code: 'OTHER' };
        const p = await applyPaymentOutcome(tx, {
          id: t.subjectId,
          result,
          pspId: t.pspId,
          hadTechnicalDecline: Boolean(td),
          now,
          ...(out.domainOutcome.to === 'FAILED' ? { errorCode: out.domainOutcome.code } : {}),
        });
        domainAfter = p.state as DomainState;
      }

      if (complaint && complaintChanged && complaintStatus) {
        await tx.update(udirComplaints).set({ status: complaintStatus, lastStatusAt: now }).where(eq(udirComplaints.id, complaint.id));
        await recordEvents(tx, { ...ctx, ...(openCase ? { caseId: openCase.id } : {}) }, [
          { type: 'UDIR_COMPLAINT_UPDATED', data: { status: complaintStatus } },
        ]);
      }

      const c = await this.reconcileCase(tx, tracking, domainAfter, out.mismatch, now, complaintStatus);

      // Tell the merchant's systems about money movements they would otherwise only see in the dashboard.
      const happened = new Set(out.events.map((e) => e.type));
      const notify: WebhookEvent[] = [];
      if (happened.has('REVERSAL_INITIATED')) notify.push('payment.reversal_initiated');
      if (happened.has('REVERSAL_COMPLETED')) notify.push('payment.reversed');
      if (out.mismatch && happened.has('CAPTURE_CONFIRMED')) notify.push('payment.captured_after_failure');
      if (notify.length > 0) {
        const payload = await paymentFactsPayload(tx, tracking, c);
        for (const event of notify) await enqueueWebhook(tx, { merchantId: t.merchantId, event, payload, now });
      }
      return { tracking, case: c };
    });
  }

  /**
   * Open, update or resolve the payment's case from current facts. Deterministic: the same
   * facts always yield the same case status.
   */
  async reconcileCase(
    tx: DbOrTx,
    t: Tracking,
    domainState: DomainState,
    mismatch: boolean,
    now: Date,
    complaintStatusOverride?: ComplaintStatus | null,
    forceReason?: CaseReason,
  ): Promise<PaymentCase | null> {
    const existing = await this.openCase(tx, t.subjectType, t.subjectId);
    let reason: CaseReason | null = existing?.reason ?? forceReason ?? null;
    // A short-paid settlement is the more specific problem than "not settled yet": it takes over.
    if (forceReason === 'SETTLEMENT_MISMATCH' && existing?.reason === 'NOT_SETTLED') reason = forceReason;
    if (mismatch) reason = 'STATUS_MISMATCH';
    if (!reason) {
      if (t.verificationStatus === 'NEEDS_MANUAL_INVESTIGATION') reason = 'VERIFICATION_EXHAUSTED';
      else if (t.customerDebit === 'DEBITED' && t.capture !== 'CAPTURED' && domainState === 'FAILED') reason = 'DEBITED_NOT_CAPTURED';
    }
    if (!reason) return null;

    const complaint = existing ? await this.latestComplaint(tx, existing.id) : undefined;
    const input = {
      reason,
      domainState,
      customerDebit: t.customerDebit,
      capture: t.capture,
      reversalStatus: t.reversalStatus,
      verificationStatus: t.verificationStatus,
      complaintStatus: complaintStatusOverride !== undefined ? complaintStatusOverride : (complaint?.status ?? null),
      closedByMerchant: existing?.closedByMerchant ?? false,
      settlementStatus: t.settlementStatus,
    };
    const status = caseStatus(input);
    const resolution = caseResolution(input);
    const ctx = { merchantId: t.merchantId, subjectType: t.subjectType, subjectId: t.subjectId, actor: SYSTEM, now };

    if (!existing) {
      if (status === 'RESOLVED') return null; // nothing to work on
      const [c] = await tx
        .insert(paymentCases)
        .values({ id: newId('cas'), merchantId: t.merchantId, subjectType: t.subjectType, subjectId: t.subjectId, trackingId: t.id, reason, status, openedAt: now, updatedAt: now })
        .returning();
      await recordEvents(tx, { ...ctx, caseId: c!.id }, [{ type: 'CASE_OPENED', data: { reason, status } }]);
      if (status === 'NEEDS_ACTION') await this.notifyCase(tx, t, c!, 'case.needs_action', now);
      return c!;
    }

    if (status === existing.status && reason === existing.reason) return existing;
    const [c] = await tx
      .update(paymentCases)
      .set({ reason, status, resolution, ...(status === 'RESOLVED' ? { resolvedAt: now } : {}), updatedAt: now })
      .where(eq(paymentCases.id, existing.id))
      .returning();
    const events: NewEvent[] =
      status === 'RESOLVED' ? [{ type: 'CASE_RESOLVED', data: { resolution } }] : [{ type: 'CASE_STATUS_CHANGED', data: { from: existing.status, to: status } }];
    await recordEvents(tx, { ...ctx, caseId: existing.id }, events);
    if (status === 'RESOLVED') await this.notifyCase(tx, t, c!, 'case.resolved', now);
    else if (status === 'NEEDS_ACTION' && existing.status !== 'NEEDS_ACTION') await this.notifyCase(tx, t, c!, 'case.needs_action', now);
    return c!;
  }

  private async notifyCase(tx: DbOrTx, t: Tracking, c: PaymentCase, event: 'case.needs_action' | 'case.resolved', now: Date) {
    await enqueueWebhook(tx, { merchantId: t.merchantId, event, payload: await paymentFactsPayload(tx, t, c), now });
  }

  async openCase(db: DbOrTx, subjectType: SubjectType, subjectId: string): Promise<PaymentCase | undefined> {
    const [c] = await db
      .select()
      .from(paymentCases)
      .where(and(eq(paymentCases.subjectType, subjectType), eq(paymentCases.subjectId, subjectId), ne(paymentCases.status, 'RESOLVED')))
      .orderBy(desc(paymentCases.openedAt))
      .limit(1);
    return c;
  }

  async latestComplaint(db: DbOrTx, caseId: string) {
    const [c] = await db.select().from(udirComplaints).where(eq(udirComplaints.caseId, caseId)).orderBy(desc(udirComplaints.raisedAt)).limit(1);
    return c;
  }

  /** Card/netbanking checkouts may be retried on the same order for a while after a failed attempt. */
  private async retryOpenUntil(t: Tracking): Promise<Date | null> {
    if (t.subjectType !== 'COLLECT') return null;
    const [p] = await this.deps.db.select({ channel: payments.channel, createdAt: payments.createdAt }).from(payments).where(eq(payments.id, t.subjectId));
    if (!p || (p.channel !== 'CARD' && p.channel !== 'NETBANKING')) return null;
    return new Date(p.createdAt.getTime() + this.deps.cfg.checkoutRetryWindowMs);
  }

  /** What the PSP needs to look this transaction up: AutoPay needs the mandate and base payment. */
  private async txnContext(t: Tracking): Promise<TxnContext> {
    if (t.subjectType === 'COLLECT') return { kind: 'COLLECT' };
    const [row] = await this.deps.db
      .select({ mandateRef: mandates.mandateRef })
      .from(debits)
      .innerJoin(mandates, eq(mandates.id, debits.mandateId))
      .where(eq(debits.id, t.subjectId));
    return { kind: 'MANDATE', mandateRef: row?.mandateRef ?? '', noticeRef: t.subjectId };
  }

  async domainState(subjectType: SubjectType, subjectId: string): Promise<DomainState> {
    const { db } = this.deps;
    if (subjectType === 'COLLECT') {
      const [p] = await db.select({ state: payments.state }).from(payments).where(eq(payments.id, subjectId));
      if (!p) throw new Error(`Payment ${subjectId} not found`);
      return p.state;
    }
    const [d] = await db.select({ state: debits.state }).from(debits).where(eq(debits.id, subjectId));
    if (!d) throw new Error(`Debit ${subjectId} not found`);
    return d.state === 'SUCCEEDED' || d.state === 'FAILED' ? d.state : 'PENDING';
  }
}
