import { and, asc, count, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { caseNotes, dashboardUsers, debits, paymentAttempts, paymentCases, payments, udirComplaints } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents, type Actor } from '../events/record.js';
import { newId } from '../ids.js';
import type { PspRegistry } from '../psp/registry.js';
import type { ComplaintReason } from '../psp/types.js';
import type { InitialOutcome, PaymentCase, Tracking, TrackingService } from '../tracking/service.js';
import type { CaseStatus, DomainState, SubjectType } from '../tracking/types.js';

export interface SubjectRef {
  type: SubjectType;
  id: string;
}

interface Subject {
  merchantId: string;
  amountPaise: number;
  domainState: DomainState;
  /** Not yet sent to any PSP (AutoPay debit waiting for its slot). */
  unsubmitted: boolean;
  pspId: string | null;
  initial: InitialOutcome;
}

const CASE_STATUSES: CaseStatus[] = ['NEEDS_ACTION', 'INVESTIGATING', 'VERIFICATION_PENDING', 'REVERSAL_PENDING', 'RESOLVED'];
const ACTIVE_COMPLAINT = new Set(['SUBMITTED', 'IN_PROGRESS']);

/**
 * Merchant-initiated investigation actions: recheck, notes, UDIR complaints, closing cases.
 * All PSP/UDIR traffic goes through the adapter registry; nothing here is PSP-specific.
 */
export class DisputeService {
  constructor(private readonly deps: { db: Db; clock: Clock; psps: PspRegistry; tracking: TrackingService }) {}

  /** "Recheck now": one immediate, lease-guarded status check, attributed to the user. */
  async recheck(merchantId: string, ref: SubjectRef, actor: Actor): Promise<{ tracking: Tracking; case: PaymentCase | null }> {
    const t = await this.ensureTracking(merchantId, ref);
    const r = await this.deps.tracking.check(t.id, actor, { manual: true });
    return r!;
  }

  async raiseComplaint(merchantId: string, ref: SubjectRef, actor: Actor & { type: 'DASHBOARD_USER' }, reason: ComplaintReason): Promise<PaymentCase> {
    const { db, clock, psps, tracking } = this.deps;
    const subject = await this.subject(merchantId, ref);
    const t = await this.ensureTracking(merchantId, ref);
    if (!t.pspId || !t.txnRef) throw new AppError('COMPLAINT_NOT_ALLOWED', 'This payment never reached a payment provider');
    if (t.customerDebit === 'NOT_DEBITED') throw new AppError('COMPLAINT_NOT_ALLOWED', 'The customer was not debited for this payment');
    if (subject.domainState === 'SUCCEEDED') throw new AppError('COMPLAINT_NOT_ALLOWED', 'This payment was captured successfully');

    const existingCase = await tracking.openCase(db, ref.type, ref.id);
    if (existingCase) {
      const latest = await tracking.latestComplaint(db, existingCase.id);
      if (latest && ACTIVE_COMPLAINT.has(latest.status)) return existingCase; // idempotent
    }

    const priorComplaints = await db.select({ n: count() }).from(udirComplaints).innerJoin(paymentCases, eq(paymentCases.id, udirComplaints.caseId)).where(eq(paymentCases.trackingId, t.id));
    const adapter = psps.get(t.pspId);
    const res = await adapter.raiseComplaint({
      txnRef: t.txnRef,
      ...(t.upiRrn ? { upiRrn: t.upiRrn } : {}),
      amountPaise: subject.amountPaise,
      reason,
      idempotencyKey: `${t.id}:${priorComplaints[0]?.n ?? 0}`,
    });
    if (!res.ok) throw new AppError('COMPLAINT_FAILED', `The payment provider did not accept the complaint: ${res.reason}`);

    const now = clock.now();
    return db.transaction(async (tx) => {
      let c = existingCase;
      if (!c) {
        const [created] = await tx
          .insert(paymentCases)
          .values({ id: newId('cas'), merchantId, subjectType: ref.type, subjectId: ref.id, trackingId: t.id, reason: 'MERCHANT_RAISED', status: 'INVESTIGATING', openedAt: now, updatedAt: now })
          .returning();
        c = created!;
        await recordEvents(tx, { merchantId, subjectType: ref.type, subjectId: ref.id, caseId: c.id, actor, now }, [{ type: 'CASE_OPENED', data: { reason: 'MERCHANT_RAISED', status: 'INVESTIGATING' } }]);
      }
      await tx.insert(udirComplaints).values({
        id: newId('cmp'),
        caseId: c.id,
        merchantId,
        pspId: t.pspId!,
        mode: adapter.mode,
        pspComplaintRef: res.pspComplaintRef,
        reasonCode: reason,
        status: res.status,
        raisedByUserId: actor.id,
        raisedAt: now,
        lastStatusAt: now,
      });
      await recordEvents(tx, { merchantId, subjectType: ref.type, subjectId: ref.id, caseId: c.id, actor, now }, [
        { type: 'UDIR_COMPLAINT_RAISED', data: { mode: adapter.mode, pspComplaintRef: res.pspComplaintRef, reason } },
      ]);
      // Watch again with a fresh budget so complaint progress and reversals are picked up.
      await tracking.restartWatch(tx, t.id, now);
      const [fresh] = await tx.select().from(paymentCases).where(eq(paymentCases.id, c.id));
      const tFresh = (await tracking.getBySubject(tx, ref.type, ref.id))!;
      return (await tracking.reconcileCase(tx, tFresh, subject.domainState, fresh!.reason === 'STATUS_MISMATCH', now)) ?? fresh!;
    });
  }

  async addNote(merchantId: string, caseId: string, actor: Actor & { type: 'DASHBOARD_USER' }, body: string) {
    const { db, clock } = this.deps;
    const c = await this.getCaseRow(merchantId, caseId);
    const now = clock.now();
    return db.transaction(async (tx) => {
      const [note] = await tx.insert(caseNotes).values({ id: newId('not'), caseId, merchantId, authorUserId: actor.id, body, createdAt: now }).returning();
      await recordEvents(tx, { merchantId, subjectType: c.subjectType, subjectId: c.subjectId, caseId, actor, now }, [{ type: 'NOTE_ADDED', data: { noteId: note!.id } }]);
      return note!;
    });
  }

  /**
   * Close a case the merchant has handled outside the system (e.g. fulfilled the order after a
   * late capture). Only cases needing action can be closed, and a note explaining why is required.
   */
  async closeCase(merchantId: string, caseId: string, actor: Actor & { type: 'DASHBOARD_USER' }, note: string): Promise<PaymentCase> {
    const { db, clock, tracking } = this.deps;
    const c = await this.getCaseRow(merchantId, caseId);
    if (c.status !== 'NEEDS_ACTION') throw new AppError('CONFLICT', 'Only cases that need action can be closed manually');
    const subject = await this.subject(merchantId, { type: c.subjectType, id: c.subjectId });
    const now = clock.now();
    return db.transaction(async (tx) => {
      await tx.insert(caseNotes).values({ id: newId('not'), caseId, merchantId, authorUserId: actor.id, body: note, createdAt: now });
      await recordEvents(tx, { merchantId, subjectType: c.subjectType, subjectId: c.subjectId, caseId, actor, now }, [{ type: 'NOTE_ADDED' }]);
      await tx.update(paymentCases).set({ closedByMerchant: true }).where(eq(paymentCases.id, caseId));
      const t = (await tracking.getBySubject(tx, c.subjectType, c.subjectId))!;
      return (await tracking.reconcileCase(tx, t, subject.domainState, false, now))!;
    });
  }

  async listCases(merchantId: string, opts: { status?: CaseStatus; before?: Date; limit: number }) {
    const { db } = this.deps;
    const conds = [eq(paymentCases.merchantId, merchantId)];
    if (opts.status) conds.push(eq(paymentCases.status, opts.status));
    if (opts.before) conds.push(lt(paymentCases.openedAt, opts.before));
    const rows = await db.select().from(paymentCases).where(and(...conds)).orderBy(desc(paymentCases.openedAt)).limit(opts.limit + 1);
    const grouped = await db.select({ status: paymentCases.status, n: count() }).from(paymentCases).where(eq(paymentCases.merchantId, merchantId)).groupBy(paymentCases.status);
    const counts = Object.fromEntries(CASE_STATUSES.map((s) => [s, 0])) as Record<CaseStatus, number>;
    for (const g of grouped) counts[g.status] = Number(g.n);
    const page = rows.slice(0, opts.limit);
    return { data: page, counts, nextBefore: rows.length > opts.limit ? page.at(-1)!.openedAt : null };
  }

  async getCase(merchantId: string, caseId: string) {
    const { db } = this.deps;
    const c = await this.getCaseRow(merchantId, caseId);
    const complaints = await db.select().from(udirComplaints).where(eq(udirComplaints.caseId, caseId)).orderBy(asc(udirComplaints.raisedAt));
    const notes = await db.select().from(caseNotes).where(eq(caseNotes.caseId, caseId)).orderBy(asc(caseNotes.createdAt));
    const authorIds = [...new Set([...notes.map((n) => n.authorUserId), ...complaints.flatMap((x) => (x.raisedByUserId ? [x.raisedByUserId] : []))])];
    const authors = authorIds.length
      ? await db.select({ id: dashboardUsers.id, name: dashboardUsers.name }).from(dashboardUsers).where(inArray(dashboardUsers.id, authorIds))
      : [];
    return { case: c, complaints, notes, userNames: new Map(authors.map((a) => [a.id, a.name])) };
  }

  /** Open case for a payment, if any. */
  async openCaseFor(merchantId: string, ref: SubjectRef): Promise<PaymentCase | undefined> {
    const [c] = await this.deps.db
      .select()
      .from(paymentCases)
      .where(and(eq(paymentCases.merchantId, merchantId), eq(paymentCases.subjectType, ref.type), eq(paymentCases.subjectId, ref.id), ne(paymentCases.status, 'RESOLVED')))
      .limit(1);
    return c;
  }

  private async getCaseRow(merchantId: string, caseId: string): Promise<PaymentCase> {
    const [c] = await this.deps.db.select().from(paymentCases).where(and(eq(paymentCases.id, caseId), eq(paymentCases.merchantId, merchantId)));
    if (!c) throw new AppError('NOT_FOUND', `Case ${caseId} not found`);
    return c;
  }

  /**
   * Payments created before Phase 3 have no tracking row. Build one from the Phase 1–2
   * records the first time someone investigates them.
   */
  private async ensureTracking(merchantId: string, ref: SubjectRef): Promise<Tracking> {
    const { db, clock, tracking } = this.deps;
    const subject = await this.subject(merchantId, ref);
    const existing = await tracking.getBySubject(db, ref.type, ref.id);
    if (existing) return existing;
    if (subject.unsubmitted) throw new AppError('CONFLICT', 'This payment has not been sent to a payment provider yet');
    const [attempt] = await db
      .select({ pspId: paymentAttempts.pspId, txnRef: paymentAttempts.txnRef })
      .from(paymentAttempts)
      .where(and(ref.type === 'COLLECT' ? eq(paymentAttempts.paymentId, ref.id) : eq(paymentAttempts.debitId, ref.id), ne(paymentAttempts.op, 'status')))
      .orderBy(desc(paymentAttempts.createdAt))
      .limit(1);
    return db.transaction((tx) =>
      tracking.recordOutcome(tx, {
        merchantId,
        subjectType: ref.type,
        subjectId: ref.id,
        pspId: attempt?.pspId ?? subject.pspId,
        txnRef: attempt?.txnRef ?? null,
        outcome: subject.initial,
        now: clock.now(),
      }),
    );
  }

  private async subject(merchantId: string, ref: SubjectRef): Promise<Subject> {
    const { db } = this.deps;
    if (ref.type === 'COLLECT') {
      const [p] = await db.select().from(payments).where(and(eq(payments.id, ref.id), eq(payments.merchantId, merchantId)));
      if (!p) throw new AppError('NOT_FOUND', `Payment ${ref.id} not found`);
      const initial: InitialOutcome = p.state === 'SUCCEEDED' ? { kind: 'SUCCEEDED' } : p.state === 'PENDING' ? { kind: 'PENDING' } : { kind: 'FAILED_TECHNICAL' };
      return { merchantId, amountPaise: p.amountPaise, domainState: p.state, unsubmitted: false, pspId: p.pspId, initial };
    }
    const [d] = await db.select().from(debits).where(and(eq(debits.id, ref.id), eq(debits.merchantId, merchantId)));
    if (!d) throw new AppError('NOT_FOUND', `Payment ${ref.id} not found`);
    const domainState: DomainState = d.state === 'SUCCEEDED' || d.state === 'FAILED' ? d.state : 'PENDING';
    const initial: InitialOutcome = d.state === 'SUCCEEDED' ? { kind: 'SUCCEEDED' } : d.state === 'FAILED' ? { kind: 'FAILED_TECHNICAL' } : { kind: 'PENDING' };
    return { merchantId, amountPaise: d.amountPaise, domainState, unsubmitted: d.attempts === 0 && d.state === 'SCHEDULED', pspId: d.lastPspId, initial };
  }
}
