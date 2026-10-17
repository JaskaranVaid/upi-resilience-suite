import { and, eq, inArray } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { Clock } from '../clock.js';
import { AUTOPAY_NO_AFA_LIMIT_PAISE } from '../config/rules.js';
import type { Db } from '../db/client.js';
import { debits, mandates, shadowDebits, type FailureKind, type ShadowOutcome } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import { istDateString } from '../rules/time.js';
import type { DebitWorker } from '../scheduler/worker.js';
import { DebitKeyTaken, liveKeyExists, lockDebitKey } from './keys.js';
import type { ShadowDebit, ShadowService } from './shadow.js';

export const MAX_EXECUTION_REPORTS = 5000;
/** Clocks differ: an execution reported this far "in the future" is still accepted. */
const CLOCK_SKEW_MS = 5 * 60_000;

const timestamp = z.iso.datetime({ offset: true });

/** One execution by the merchant's own system (the legacy path), as reported. */
export const executionReport = z
  .object({
    /** The key the debit was requested with (POST /v1/mandates/:id/debits), or any unique id for history. */
    idempotencyKey: z.string().min(1).max(255),
    /** Required when the key names no debit we know (history). */
    mandateRef: z.string().min(1).max(255).optional(),
    amountPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    orderId: z.string().min(1).max(255).optional(),
    /** When the billing system asked for the debit (history; defaults to executedAt). */
    requestedAt: timestamp.optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
    executedAt: timestamp,
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    /** Why it failed: TECHNICAL (bank/switch/PSP), BUSINESS (customer side, e.g. funds) or UNKNOWN. Only TECHNICAL failures count as recoverable. */
    failureKind: z.enum(['TECHNICAL', 'BUSINESS', 'UNKNOWN']).optional(),
    /** The PSP's or NPCI's code, kept for your reference. */
    failureCode: z.string().min(1).max(64).optional(),
    pspTxnId: z.string().min(1).max(128).optional(),
    /** How many attempts your system made. */
    attempts: z.number().int().min(1).max(20).optional(),
  })
  .strict()
  .meta({ id: 'ExecutionReport' });

export const executionReportsBody = z.object({ executions: z.array(z.unknown()).min(1).max(MAX_EXECUTION_REPORTS) }).strict();

const REPORT_STATUSES = ['RECORDED', 'UPDATED', 'UNCHANGED', 'CREATED', 'MISROUTED', 'CONFLICT', 'INVALID'] as const;

export const executionReportsResponse = z
  .object({
    summary: z.object({
      recorded: z.number().int(), updated: z.number().int(), unchanged: z.number().int(), created: z.number().int(),
      misrouted: z.number().int(), conflicts: z.number().int(), invalid: z.number().int(),
    }),
    results: z.array(
      z.object({
        index: z.number().int(),
        idempotencyKey: z.string().nullable(),
        /** RECORDED/UPDATED/UNCHANGED: a shadow debit's outcome; CREATED: a new reported shadow debit; MISROUTED: the key names a debit Merchantflo executes. */
        status: z.enum(REPORT_STATUSES),
        shadowDebitId: z.string().optional(),
        debitId: z.string().optional(),
        handedBack: z.boolean().optional(),
        debitState: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
  })
  .meta({ id: 'ExecutionReportResult' });

export const CSV_HEADER = ['idempotencyKey', 'mandateRef', 'amountPaise', 'requestedAt', 'dueDate', 'executedAt', 'outcome', 'failureKind', 'failureCode', 'pspTxnId', 'attempts', 'orderId'];

/** A CSV row (strings) as a report item: blanks dropped, numbers parsed. */
export function fromCsvRow(r: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    const value = v.trim();
    if (value === '') continue;
    out[k] = k === 'amountPaise' || k === 'attempts' ? Number(value) : value;
  }
  return out;
}

type Report = z.infer<typeof executionReport>;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportResult {
  index: number;
  idempotencyKey: string | null;
  status: ReportStatus;
  shadowDebitId?: string;
  /** MISROUTED: the Merchantflo debit this key names, whether it was handed back, and its state now. */
  debitId?: string;
  handedBack?: boolean;
  debitState?: string;
  error?: string;
}

const SUMMARY_KEYS: Record<ReportStatus, string> = {
  RECORDED: 'recorded', UPDATED: 'updated', UNCHANGED: 'unchanged', CREATED: 'created', MISROUTED: 'misrouted', CONFLICT: 'conflicts', INVALID: 'invalid',
};

class ItemError extends Error {
  constructor(readonly status: 'CONFLICT' | 'INVALID', message: string) {
    super(message);
  }
}

const reasonOf = (e: unknown) => (e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`).join('; ') : e instanceof Error ? e.message : String(e));

/**
 * What the merchant's own system did with its debits during a pilot (and, for a backtest, before
 * it). Each item is matched by idempotency key: to a shadow debit (its outcome is recorded), to a
 * debit Merchantflo owns (a misroute: handed back if not started), or to nothing (a new reported
 * shadow debit, planned as Merchantflo would have planned it). Items are judged one by one.
 */
export class ExecutionReports {
  constructor(private readonly deps: { db: Db; clock: Clock; shadow: ShadowService; worker: DebitWorker }) {}

  async report(merchantId: string, items: unknown[]) {
    if (items.length > MAX_EXECUTION_REPORTS) throw new AppError('VALIDATION', `At most ${MAX_EXECUTION_REPORTS} executions per request`);
    const results: ReportResult[] = [];
    const CHUNK = 500;
    for (let start = 0; start < items.length; start += CHUNK) {
      const chunk = items.slice(start, start + CHUNK);
      const parsed = chunk.map((raw, i) => {
        const index = start + i;
        const key = typeof (raw as { idempotencyKey?: unknown })?.idempotencyKey === 'string' ? (raw as { idempotencyKey: string }).idempotencyKey : null;
        try {
          return { index, key, item: this.validate(executionReport.parse(raw)) };
        } catch (e) {
          return { index, key, error: reasonOf(e) };
        }
      });
      const keys = parsed.flatMap((p) => ('item' in p ? [p.item!.idempotencyKey] : []));
      const refs = parsed.flatMap((p) => ('item' in p && p.item!.mandateRef ? [p.item!.mandateRef] : []));
      const [lives, shadows, known] = await Promise.all([
        keys.length ? this.deps.db.select().from(debits).where(and(eq(debits.merchantId, merchantId), inArray(debits.idempotencyKey, keys))) : [],
        keys.length ? this.deps.db.select().from(shadowDebits).where(and(eq(shadowDebits.merchantId, merchantId), inArray(shadowDebits.idempotencyKey, keys))) : [],
        refs.length ? this.deps.db.select().from(mandates).where(and(eq(mandates.merchantId, merchantId), inArray(mandates.mandateRef, refs))) : [],
      ]);
      const live = new Map(lives.map((d) => [d.idempotencyKey, d]));
      const shadow = new Map(shadows.map((s) => [s.idempotencyKey, s]));
      const mandateByRef = new Map(known.map((m) => [m.mandateRef, m]));
      const mandateById = new Map(known.map((m) => [m.id, m]));

      for (const p of parsed) {
        if (!('item' in p)) {
          results.push({ index: p.index, idempotencyKey: p.key, status: 'INVALID', error: p.error! });
          continue;
        }
        const item = p.item!;
        try {
          const d = live.get(item.idempotencyKey);
          let r: Omit<ReportResult, 'index' | 'idempotencyKey'>;
          if (d) {
            const [m] = mandateById.get(d.mandateId) ? [mandateById.get(d.mandateId)!] : await this.deps.db.select().from(mandates).where(eq(mandates.id, d.mandateId));
            r = await this.misrouted(merchantId, item, d, m!, shadow.get(item.idempotencyKey));
          } else {
            const s = shadow.get(item.idempotencyKey);
            r = s ? await this.record(s, item) : await this.create(merchantId, item, mandateByRef.get(item.mandateRef ?? ''));
          }
          if (r.shadowDebitId) {
            const [fresh] = await this.deps.db.select().from(shadowDebits).where(eq(shadowDebits.id, r.shadowDebitId));
            if (fresh) shadow.set(item.idempotencyKey, fresh); // a repeat of the key later in this request sees it
          }
          results.push({ index: p.index, idempotencyKey: item.idempotencyKey, ...r });
        } catch (e) {
          if (!(e instanceof ItemError)) throw e;
          results.push({ index: p.index, idempotencyKey: item.idempotencyKey, status: e.status, error: e.message });
        }
      }
    }
    const summary = Object.fromEntries(Object.values(SUMMARY_KEYS).map((k) => [k, 0])) as Record<string, number>;
    for (const r of results) summary[SUMMARY_KEYS[r.status]]!++;
    return { summary, results };
  }

  private validate(item: Report): Report {
    const now = this.deps.clock.now().getTime();
    if (Date.parse(item.executedAt) > now + CLOCK_SKEW_MS) throw new ItemError('INVALID', 'executedAt is in the future');
    if (item.requestedAt && Date.parse(item.requestedAt) > Date.parse(item.executedAt)) throw new ItemError('INVALID', 'requestedAt is after executedAt');
    if (item.outcome === 'SUCCEEDED' && (item.failureKind || item.failureCode)) throw new ItemError('INVALID', 'failureKind and failureCode are only for a FAILED execution');
    return item;
  }

  /** The outcome columns for a report. */
  private outcome(item: Report, now: Date) {
    const failed = item.outcome === 'FAILED';
    return {
      executedAt: new Date(item.executedAt),
      outcome: item.outcome as ShadowOutcome,
      failureKind: failed ? ((item.failureKind ?? 'UNKNOWN') as FailureKind) : null,
      failureCode: failed ? (item.failureCode ?? null) : null,
      pspTxnId: item.pspTxnId ?? null,
      legacyAttempts: item.attempts ?? null,
      reportedAt: now,
      updatedAt: now,
    };
  }

  private assertMatches(item: Report, expected: { mandateRef: string; amountPaise: number }, what: string) {
    if (item.mandateRef !== undefined && item.mandateRef !== expected.mandateRef) throw new ItemError('CONFLICT', `${what} is for mandate ${expected.mandateRef}, not ${item.mandateRef}`);
    if (item.amountPaise !== undefined && item.amountPaise !== expected.amountPaise) throw new ItemError('CONFLICT', `${what} is for ${expected.amountPaise} paise, not ${item.amountPaise}`);
  }

  private async record(s: ShadowDebit, item: Report): Promise<Omit<ReportResult, 'index' | 'idempotencyKey'>> {
    this.assertMatches(item, s, 'This shadow debit');
    const now = this.deps.clock.now();
    const next = this.outcome(item, now);
    const same =
      s.outcome === next.outcome && s.executedAt?.getTime() === next.executedAt.getTime() && s.failureKind === next.failureKind &&
      s.failureCode === next.failureCode && s.pspTxnId === next.pspTxnId && s.legacyAttempts === next.legacyAttempts;
    if (same) return { status: 'UNCHANGED', shadowDebitId: s.id };
    await this.deps.db.update(shadowDebits).set(next).where(eq(shadowDebits.id, s.id));
    return { status: s.outcome ? 'UPDATED' : 'RECORDED', shadowDebitId: s.id };
  }

  /** The merchant executed a debit Merchantflo owns: keep the report, and hand ours back if not started. */
  private async misrouted(
    merchantId: string,
    item: Report,
    d: typeof debits.$inferSelect,
    m: typeof mandates.$inferSelect,
    existing: ShadowDebit | undefined,
  ): Promise<Omit<ReportResult, 'index' | 'idempotencyKey'>> {
    this.assertMatches(item, { mandateRef: m.mandateRef, amountPaise: d.amountPaise }, `Debit ${d.id}`);
    const now = this.deps.clock.now();
    let shadowDebitId: string;
    if (existing) {
      await this.deps.db.update(shadowDebits).set(this.outcome(item, now)).where(eq(shadowDebits.id, existing.id));
      shadowDebitId = existing.id;
    } else {
      shadowDebitId = newId('shd');
      await this.deps.db
        .insert(shadowDebits)
        .values({
          id: shadowDebitId,
          merchantId,
          mandateId: m.id,
          mandateRef: m.mandateRef,
          idempotencyKey: d.idempotencyKey,
          orderId: d.orderId,
          amountPaise: d.amountPaise,
          source: 'REPORTED',
          rolloutStage: d.rolloutStage,
          requestedAt: d.requestedAt,
          requestedInPeak: d.requestedInPeak,
          dueDate: d.dueDate,
          plannedAt: d.scheduledAt,
          plannedNoticeDate: d.noticeDate ?? istDateString(d.scheduledAt),
          liveDebitId: d.id,
          createdAt: now,
          ...this.outcome(item, now),
        })
        .onConflictDoNothing({ target: [shadowDebits.merchantId, shadowDebits.idempotencyKey] });
    }
    const { handedBack, state } = await this.deps.worker.handBack(merchantId, d.id);
    return { status: 'MISROUTED', shadowDebitId, debitId: d.id, handedBack, debitState: state };
  }

  /** History (or an execution never sent to intake): a reported shadow debit, planned at its request time. */
  private async create(merchantId: string, item: Report, mandate: typeof mandates.$inferSelect | undefined): Promise<Omit<ReportResult, 'index' | 'idempotencyKey'>> {
    if (!item.mandateRef || item.amountPaise === undefined) throw new ItemError('INVALID', 'No debit has this idempotencyKey: give mandateRef and amountPaise to record it');
    const now = this.deps.clock.now();
    const id = newId('shd');
    const requestedAt = new Date(item.requestedAt ?? item.executedAt);
    const planned = await this.deps.shadow.planFor(mandate ?? null, id, requestedAt, item.dueDate ?? null);
    // What intake would have refused then: the amount checks (a mandate's status then is unknown).
    const noAfa = mandate?.noAfaLimitPaise ?? AUTOPAY_NO_AFA_LIMIT_PAISE;
    const refuse = mandate && item.amountPaise > mandate.maxAmountPaise ? 'AMOUNT_EXCEEDS_MANDATE' : item.amountPaise > noAfa ? 'AFA_REQUIRED' : null;
    try {
      await this.deps.db.transaction(async (tx) => {
        await lockDebitKey(tx, merchantId, item.idempotencyKey);
        if (await liveKeyExists(tx, merchantId, item.idempotencyKey)) throw new DebitKeyTaken('LIVE');
        await tx.insert(shadowDebits).values({
          id,
          merchantId,
          mandateId: mandate?.id ?? null,
          mandateRef: item.mandateRef!,
          idempotencyKey: item.idempotencyKey,
          orderId: item.orderId ?? null,
          amountPaise: item.amountPaise!,
          source: 'REPORTED',
          rolloutStage: null,
          requestedAt,
          dueDate: item.dueDate ?? null,
          ...planned,
          wouldRefuse: refuse,
          createdAt: now,
          ...this.outcome(item, now),
        });
      });
    } catch (e) {
      // The key was taken meanwhile (a debit request with it, or a parallel report): report it again.
      if (e instanceof DebitKeyTaken || (e instanceof Error && /duplicate key|unique/i.test(e.message))) {
        throw new ItemError('CONFLICT', 'A debit with this idempotencyKey was created meanwhile; report it again');
      }
      throw e;
    }
    return { status: 'CREATED', shadowDebitId: id };
  }
}
