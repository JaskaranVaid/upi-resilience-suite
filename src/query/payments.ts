import { and, asc, desc, eq, gte, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { PollingConfig } from '../config/polling.js';
import type { Db } from '../db/client.js';
import { dashboardUsers, merchantPaymentsView, paymentCases, paymentEvents, udirComplaints } from '../db/schema.js';
import { complaintEligibility, supportsComplaints } from '../disputes/rules.js';
import { AppError } from '../errors.js';
import { CASE_STATUS_LABELS, toTimeline, type TimelineItem } from '../events/timeline.js';
import type { PspRegistry } from '../psp/registry.js';
import type { PspMode } from '../psp/types.js';
import { customerStatus, merchantStatus, MERCHANT_STATUS_LABELS, type MerchantStatus } from '../tracking/derive.js';
import type { SubjectType } from '../tracking/types.js';

type ViewRow = typeof merchantPaymentsView.$inferSelect;
const v = merchantPaymentsView;

/**
 * SQL mirror of merchantStatus() so lists can be filtered and counted in the database.
 * Branch order MUST match derive.ts; test/query/payments.test.ts checks they agree.
 */
export function merchantStatusSql(now: Date, cfg: PollingConfig): SQL<MerchantStatus> {
  const verifyingBefore = new Date(now.getTime() - cfg.verifyingAfterMs);
  return sql<MerchantStatus>`case
    when ${v.verificationStatus} = 'NEEDS_MANUAL_INVESTIGATION' then 'NEEDS_INVESTIGATION'
    when ${v.reversalStatus} = 'COMPLETED' then 'REVERSED'
    when ${v.reversalStatus} = 'INITIATED' then 'REVERSAL_IN_PROGRESS'
    when ${v.domainState} = 'FAILED' and ${v.capture} = 'CAPTURED' then 'CAPTURED_AFTER_FAILURE'
    when ${v.domainState} <> 'PENDING' and ${v.customerDebit} = 'DEBITED' and ${v.capture} is distinct from 'CAPTURED' then 'DEBITED_NOT_CAPTURED'
    when ${v.domainState} = 'SUCCEEDED' then 'SUCCEEDED'
    when ${v.domainState} = 'PENDING' and ${v.awaitingExecution} then 'SCHEDULED'
    when (${v.domainState} = 'PENDING' and ${v.pendingSince} <= ${verifyingBefore})
      or (${v.domainState} = 'FAILED' and ${v.verificationStatus} = 'IN_PROGRESS' and ${v.customerDebit} = 'UNKNOWN') then 'VERIFYING'
    when ${v.domainState} = 'PENDING' then 'PROCESSING'
    else 'FAILED' end`;
}

export interface PaymentFilters {
  status?: MerchantStatus;
  type?: SubjectType;
  pspId?: string;
  from?: Date;
  to?: Date;
  minAmountPaise?: number;
  maxAmountPaise?: number;
  orderId?: string;
  paymentId?: string;
  upiRrn?: string;
}

export interface PaymentRow {
  type: SubjectType;
  id: string;
  orderId: string | null;
  upiRrn: string | null;
  amountPaise: number;
  merchantStatus: MerchantStatus;
  merchantStatusLabel: string;
  customerDebit: string;
  capture: string;
  reversalStatus: string;
  pspId: string | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  scheduledAt: Date | null;
  caseId: string | null;
}

export const DEBIT_LABELS: Record<string, string> = { DEBITED: 'Debited', NOT_DEBITED: 'Not debited', UNKNOWN: 'Not yet known' };
export const CAPTURE_LABELS: Record<string, string> = {
  CAPTURED: 'Captured (PSP-confirmed)',
  NOT_CAPTURED: 'Not captured',
  UNKNOWN: 'Not yet confirmed',
};
export const REVERSAL_LABELS: Record<string, string> = {
  NONE: 'None',
  INITIATED: 'Auto-reversal in progress',
  COMPLETED: 'Reversed to customer',
  UNKNOWN: 'Not yet known',
};
const VERIFICATION_LABELS: Record<string, string> = {
  NOT_REQUIRED: 'Not needed',
  IN_PROGRESS: 'Verification in progress',
  RESOLVED: 'Verification complete',
  NEEDS_MANUAL_INVESTIGATION: 'Needs manual investigation',
};

type Cursor = { t: string; id: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString()) as Cursor;
    if (typeof c.t !== 'string' || typeof c.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new AppError('VALIDATION', 'Invalid cursor');
  }
}

/** Unified Collect + AutoPay reads for the dashboard. Every query is scoped to one merchant. */
export class PaymentQueryService {
  constructor(private readonly deps: { db: Db; clock: Clock; cfg: PollingConfig; psps: PspRegistry }) {}

  async list(merchantId: string, f: PaymentFilters, page: { cursor?: string; limit: number }): Promise<{ data: PaymentRow[]; nextCursor: string | null }> {
    const { db, clock, cfg } = this.deps;
    const conds = this.filterConds(merchantId, f, clock.now(), cfg);
    if (page.cursor) {
      const c = decodeCursor(page.cursor);
      const t = new Date(c.t);
      conds.push(or(lt(v.createdAt, t), and(eq(v.createdAt, t), lt(v.id, c.id)))!);
    }
    const rows = await db.select().from(v).where(and(...conds)).orderBy(desc(v.createdAt), desc(v.id)).limit(page.limit + 1);
    const pageRows = rows.slice(0, page.limit);
    const last = pageRows.at(-1);
    return {
      data: await this.toRows(merchantId, pageRows),
      nextCursor: rows.length > page.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    };
  }

  /** Resolve a support query: 12-digit UPI reference (RRN), payment id, or merchant order id. */
  async search(merchantId: string, qRaw: string): Promise<PaymentRow[]> {
    const q = qRaw.trim();
    if (!q) return [];
    const by = /^\d{12}$/.test(q) ? eq(v.upiRrn, q) : /^(pay|dbt)_/.test(q) ? eq(v.id, q) : eq(v.orderId, q);
    const rows = await this.deps.db.select().from(v).where(and(eq(v.merchantId, merchantId), by)).orderBy(desc(v.createdAt)).limit(20);
    return this.toRows(merchantId, rows);
  }

  async overview(merchantId: string, range: { from?: Date; to?: Date }) {
    const { db, clock, cfg } = this.deps;
    const status = merchantStatusSql(clock.now(), cfg);
    const conds = this.filterConds(merchantId, range, clock.now(), cfg);
    const grouped = await db.select({ status, n: sql<number>`count(*)` }).from(v).where(and(...conds)).groupBy(sql`1`); // by position: the CASE carries bind parameters, so repeating it would not match
    const by = Object.fromEntries(Object.keys(MERCHANT_STATUS_LABELS).map((k) => [k, 0])) as Record<MerchantStatus, number>;
    for (const g of grouped) by[g.status] = Number(g.n);
    const [needs] = await db
      .select({ n: sql<number>`count(*)` })
      .from(paymentCases)
      .where(and(eq(paymentCases.merchantId, merchantId), eq(paymentCases.status, 'NEEDS_ACTION')));
    return {
      total: Object.values(by).reduce((a, b) => a + b, 0),
      succeeded: by.SUCCEEDED,
      inProgress: by.PROCESSING + by.VERIFYING + by.SCHEDULED,
      failed: by.FAILED,
      debitedNotCaptured: by.DEBITED_NOT_CAPTURED + by.CAPTURED_AFTER_FAILURE,
      reversalsPending: by.REVERSAL_IN_PROGRESS,
      reversed: by.REVERSED,
      needsInvestigation: by.NEEDS_INVESTIGATION,
      casesNeedingAction: Number(needs?.n ?? 0),
      byStatus: by,
    };
  }

  async detail(merchantId: string, type: SubjectType, id: string, viewer: { canOperate: boolean }) {
    const { db, psps } = this.deps;
    const [row] = await db.select().from(v).where(and(eq(v.merchantId, merchantId), eq(v.subjectType, type), eq(v.id, id)));
    if (!row) throw new AppError('NOT_FOUND', `Payment ${id} not found`);
    const [base] = await this.toRows(merchantId, [row]);
    const cases = await db
      .select()
      .from(paymentCases)
      .where(and(eq(paymentCases.subjectType, type), eq(paymentCases.subjectId, id)))
      .orderBy(desc(paymentCases.openedAt));
    const openCase = cases.find((c) => c.status !== 'RESOLVED') ?? null;
    const complaint = openCase
      ? (await db.select().from(udirComplaints).where(eq(udirComplaints.caseId, openCase.id)).orderBy(desc(udirComplaints.raisedAt)).limit(1))[0]
      : undefined;
    const activeComplaint = complaint?.status === 'SUBMITTED' || complaint?.status === 'IN_PROGRESS';
    const eligibility = complaintEligibility({
      domainState: row.domainState,
      customerDebit: row.customerDebit,
      submittedToPsp: Boolean(row.pspId),
      activeComplaint,
      reversalCompleted: row.reversalStatus === 'COMPLETED',
      providerSupportsComplaints: await supportsComplaints(psps, row.pspId),
    });
    const actions: string[] = [];
    // An AutoPay debit still waiting for its slot hasn't been sent anywhere yet, so there's nothing to check.
    if (viewer.canOperate && !row.awaitingExecution) actions.push('RECHECK');
    if (viewer.canOperate && eligibility.ok) actions.push('RAISE_COMPLAINT');

    let providerMode: PspMode | null = null;
    try {
      providerMode = row.pspId ? (await psps.get(row.pspId)).mode : null;
    } catch {
      providerMode = null;
    }

    return {
      ...base!,
      npciTxnId: row.npciTxnId,
      providerMode,
      money: {
        customerDebit: { code: base!.customerDebit, label: DEBIT_LABELS[base!.customerDebit] ?? base!.customerDebit },
        capture: { code: base!.capture, label: CAPTURE_LABELS[base!.capture] ?? base!.capture, note: 'PSP-confirmed capture — not a bank settlement confirmation' },
        reversal: {
          code: base!.reversalStatus,
          label: REVERSAL_LABELS[base!.reversalStatus] ?? base!.reversalStatus,
          initiatedAt: row.reversalInitiatedAt,
          completedAt: row.reversalCompletedAt,
        },
      },
      resolution: {
        verification: { code: row.verificationStatus ?? 'NOT_REQUIRED', label: VERIFICATION_LABELS[row.verificationStatus ?? 'NOT_REQUIRED'] },
        openCase: openCase ? { id: openCase.id, status: openCase.status, statusLabel: CASE_STATUS_LABELS[openCase.status] } : null,
        caseHistory: cases.map((c) => ({ id: c.id, status: c.status, openedAt: c.openedAt, resolvedAt: c.resolvedAt })),
        actionRequired: openCase?.status === 'NEEDS_ACTION',
        nextStep: nextStep(base!.merchantStatus, openCase?.status ?? null),
      },
      customerView: customerStatus(base!.merchantStatus, (row.customerDebit ?? 'UNKNOWN') as 'UNKNOWN'),
      actionsAllowed: actions,
      ...(eligibility.ok ? {} : { complaintUnavailableReason: eligibility.reason }),
    };
  }

  async timeline(merchantId: string, type: SubjectType, id: string): Promise<TimelineItem[]> {
    const { db } = this.deps;
    const rows = await db
      .select()
      .from(paymentEvents)
      .where(and(eq(paymentEvents.merchantId, merchantId), eq(paymentEvents.subjectType, type), eq(paymentEvents.subjectId, id)))
      .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.seq));
    const userIds = [...new Set(rows.flatMap((r) => (r.actorType === 'DASHBOARD_USER' && r.actorId ? [r.actorId] : [])))];
    const users = userIds.length ? await db.select({ id: dashboardUsers.id, name: dashboardUsers.name }).from(dashboardUsers).where(inArray(dashboardUsers.id, userIds)) : [];
    return toTimeline(rows, new Map(users.map((u) => [u.id, u.name])));
  }

  async rowFor(merchantId: string, type: SubjectType, id: string): Promise<PaymentRow> {
    const [row] = await this.deps.db.select().from(v).where(and(eq(v.merchantId, merchantId), eq(v.subjectType, type), eq(v.id, id)));
    if (!row) throw new AppError('NOT_FOUND', `Payment ${id} not found`);
    return (await this.toRows(merchantId, [row]))[0]!;
  }

  private filterConds(merchantId: string, f: PaymentFilters, now: Date, cfg: PollingConfig): SQL[] {
    const conds: SQL[] = [eq(v.merchantId, merchantId)];
    if (f.status) conds.push(sql`${merchantStatusSql(now, cfg)} = ${f.status}`);
    if (f.type) conds.push(eq(v.subjectType, f.type));
    if (f.pspId) conds.push(eq(v.pspId, f.pspId));
    if (f.from) conds.push(gte(v.createdAt, f.from));
    if (f.to) conds.push(lt(v.createdAt, f.to));
    if (f.minAmountPaise !== undefined) conds.push(gte(v.amountPaise, f.minAmountPaise));
    if (f.maxAmountPaise !== undefined) conds.push(lte(v.amountPaise, f.maxAmountPaise));
    if (f.orderId) conds.push(eq(v.orderId, f.orderId));
    if (f.paymentId) conds.push(eq(v.id, f.paymentId));
    if (f.upiRrn) conds.push(eq(v.upiRrn, f.upiRrn));
    return conds;
  }

  private async toRows(merchantId: string, rows: ViewRow[]): Promise<PaymentRow[]> {
    if (rows.length === 0) return [];
    const { db, clock, cfg } = this.deps;
    const now = clock.now();
    const open = await db
      .select({ subjectId: paymentCases.subjectId, id: paymentCases.id })
      .from(paymentCases)
      .where(and(eq(paymentCases.merchantId, merchantId), inArray(paymentCases.subjectId, rows.map((r) => r.id)), ne(paymentCases.status, 'RESOLVED')));
    const caseBySubject = new Map(open.map((c) => [c.subjectId, c.id]));
    return rows.map((r) => {
      const status = merchantStatus(
        {
          subjectType: r.subjectType,
          domainState: r.domainState,
          awaitingExecution: r.awaitingExecution,
          pendingSince: r.pendingSince,
          now,
          tracking: r.trackingId
            ? { customerDebit: r.customerDebit!, capture: r.capture!, reversalStatus: r.reversalStatus!, verificationStatus: r.verificationStatus! }
            : null,
        },
        cfg,
      );
      // Without tracking, the Phase 1–2 outcome is still authoritative for capture/debit.
      const captured = r.domainState === 'SUCCEEDED';
      return {
        type: r.subjectType,
        id: r.id,
        orderId: r.orderId,
        upiRrn: r.upiRrn,
        amountPaise: r.amountPaise,
        merchantStatus: status.code,
        merchantStatusLabel: status.label,
        customerDebit: r.customerDebit ?? (captured ? 'DEBITED' : 'UNKNOWN'),
        capture: r.capture ?? (captured ? 'CAPTURED' : 'UNKNOWN'),
        reversalStatus: r.reversalStatus ?? 'NONE',
        pspId: r.pspId,
        createdAt: r.createdAt,
        lastUpdatedAt: r.lastUpdatedAt,
        scheduledAt: r.awaitingExecution ? r.scheduledAt : null,
        caseId: caseBySubject.get(r.id) ?? null,
      };
    });
  }
}

/** Plain-language "what happens next" for the payment detail view. */
export function nextStep(status: MerchantStatus, caseStatus: string | null): string {
  if (caseStatus === 'NEEDS_ACTION') return 'Action needed: review this issue on the Dispute Desk.';
  if (caseStatus === 'INVESTIGATING') return 'A UDIR complaint is open with the payment provider. We are tracking it automatically.';
  switch (status) {
    case 'SCHEDULED':
      return 'Will be collected at the scheduled time. No action needed.';
    case 'PROCESSING':
    case 'VERIFYING':
      return 'We are checking the status with the payment provider automatically. No action needed.';
    case 'DEBITED_NOT_CAPTURED':
      return "We are monitoring for the bank's auto-reversal. You can raise a UDIR complaint if it does not start.";
    case 'REVERSAL_IN_PROGRESS':
      return 'The bank is reversing the amount to the customer. No action needed.';
    case 'REVERSED':
      return 'The amount was reversed to the customer. No action needed.';
    case 'CAPTURED_AFTER_FAILURE':
      return 'The provider captured this payment after it was reported failed: fulfil the order or refund the customer.';
    case 'NEEDS_INVESTIGATION':
      return 'Automatic verification has ended. Recheck, or raise a UDIR complaint with the provider.';
    case 'SUCCEEDED':
      return 'Payment captured. No action needed.';
    case 'FAILED':
      return 'Payment failed. No action needed.';
  }
}
