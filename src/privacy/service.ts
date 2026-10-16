import { and, asc, eq, gt, inArray, isNotNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { checkoutSessions, dashboardSessions, debits, mandates, operatorSessions, paymentCases, payments, webhookOutbox } from '../db/schema.js';
import { AppError } from '../errors.js';
import { recordEvents, type Actor } from '../events/record.js';
import type { OperatorService } from '../ops-console/operators.js';
import { REDACTED } from '../security/fields.js';

export { REDACTED };

export interface RetentionConfig {
  /** Personal fields of finished payments, sessions and idle revoked mandates are redacted after this many days. */
  personalDataDays: number;
  /** Delivered or dead webhook log rows are deleted after this many days. */
  webhookLogDays: number;
  /** purgeExpired runs at most this often from the worker. */
  intervalMs: number;
}

export const DEFAULT_RETENTION: RetentionConfig = { personalDataDays: 180, webhookLogDays: 30, intervalMs: 24 * 3600_000 };

export interface PurgeCounts {
  payments: number;
  checkoutSessions: number;
  mandates: number;
  webhookDeliveries: number;
  sessions: number;
}

export interface ErasureCounts {
  mandates: number;
  payments: number;
  checkoutSessions: number;
  webhookDeliveries: number;
}

/** Identifiers of one data principal (customer). */
export interface DataPrincipal {
  vpa?: string;
  phone?: string;
}

const DAY = 86_400_000;
const BATCH = 500;
const OPEN_CASE = ['NEEDS_ACTION', 'INVESTIGATING', 'VERIFICATION_PENDING', 'REVERSAL_PENDING'] as const;
const LIVE_DEBIT = ['SCHEDULED', 'EXECUTING', 'PENDING_CONFIRMATION'] as const;

const normVpa = (v: string) => v.trim().toLowerCase();
/**
 * A phone number as written (10 digits, or 0 / +91 / 91 and 10 digits, spaces and dashes allowed) →
 * its 10 digits; null for anything else, so a 12-digit UPI reference ending in the same digits
 * never matches.
 */
function normPhone(p: string): string | null {
  if (!/^\+?[\d\s-]+$/.test(p.trim())) return null;
  const d = p.replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  return null;
}

/**
 * DPDP retention and erasure. Personal fields are sealed at rest (src/security/fields.ts), so
 * matching happens on decrypted values in the application, one merchant at a time, in batches —
 * never by comparing ciphertext in SQL.
 */
export class PrivacyService {
  private readonly cfg: RetentionConfig;
  private lastRun: number | null = null;

  constructor(private readonly deps: { db: Db; clock: Clock; operators: OperatorService; cfg?: Partial<RetentionConfig> }) {
    this.cfg = { ...DEFAULT_RETENTION, ...deps.cfg };
  }

  /** The worker's entry point: purgeExpired at most once per interval (per process). Null when not due. */
  async runDue(): Promise<PurgeCounts | null> {
    const now = this.deps.clock.now().getTime();
    if (this.lastRun !== null && now - this.lastRun < this.cfg.intervalMs) return null;
    this.lastRun = now;
    return this.purgeExpired();
  }

  /** Apply the retention policy (docs/legal/retention-policy.md). Idempotent. */
  async purgeExpired(): Promise<PurgeCounts> {
    const { db, clock, operators } = this.deps;
    const now = clock.now();
    const cutoff = new Date(now.getTime() - this.cfg.personalDataDays * DAY);
    const webhookCutoff = new Date(now.getTime() - this.cfg.webhookLogDays * DAY);

    // Finished payments, unless a case on them is still open.
    const paid = await db
      .update(payments)
      .set({ payerVpa: null, customerAction: null })
      .where(
        and(
          inArray(payments.state, ['SUCCEEDED', 'FAILED']),
          lt(payments.updatedAt, cutoff),
          or(isNotNull(payments.payerVpa), isNotNull(payments.customerAction)),
          notExists(
            db
              .select({ one: sql`1` })
              .from(paymentCases)
              .where(and(eq(paymentCases.subjectType, 'COLLECT'), eq(paymentCases.subjectId, payments.id), inArray(paymentCases.status, [...OPEN_CASE]))),
          ),
        ),
      )
      .returning({ id: payments.id });

    const sessions = await db
      .update(checkoutSessions)
      .set({ customerPhone: null, customerVpa: null })
      .where(
        and(
          or(lt(checkoutSessions.expiresAt, cutoff), and(ne(checkoutSessions.status, 'OPEN'), lt(checkoutSessions.updatedAt, cutoff))),
          or(isNotNull(checkoutSessions.customerPhone), isNotNull(checkoutSessions.customerVpa)),
        ),
      )
      .returning({ id: checkoutSessions.id });

    // Revoked mandates registered before the cutoff with no live debit and none touched since.
    const idleMandates = await db
      .update(mandates)
      .set({ customerVpa: REDACTED })
      .where(
        and(
          eq(mandates.status, 'REVOKED'),
          lt(mandates.createdAt, cutoff),
          ne(mandates.customerVpa, REDACTED),
          notExists(
            db
              .select({ one: sql`1` })
              .from(debits)
              .where(and(eq(debits.mandateId, mandates.id), or(inArray(debits.state, [...LIVE_DEBIT]), gt(debits.updatedAt, cutoff)))),
          ),
        ),
      )
      .returning({ id: mandates.id });

    const hooks = await db
      .delete(webhookOutbox)
      .where(or(lt(webhookOutbox.deliveredAt, webhookCutoff), lt(webhookOutbox.deadAt, webhookCutoff)))
      .returning({ id: webhookOutbox.id });

    const dash = await db.delete(dashboardSessions).where(lt(dashboardSessions.expiresAt, now)).returning({ id: dashboardSessions.id });
    const ops = await db.delete(operatorSessions).where(lt(operatorSessions.expiresAt, now)).returning({ id: operatorSessions.id });

    const counts: PurgeCounts = {
      payments: paid.length,
      checkoutSessions: sessions.length,
      mandates: idleMandates.length,
      webhookDeliveries: hooks.length,
      sessions: dash.length + ops.length,
    };
    if (Object.values(counts).some((n) => n > 0)) await operators.audit(db, null, 'DATA_RETENTION_PURGED', null, { ...counts });
    return counts;
  }

  /**
   * Erase one customer's identifiers from one merchant's records (a data principal's request under
   * DPDP): mandate VPAs become REDACTED, payment and session fields null, and webhook log payloads
   * have every matching value replaced. Amounts, states and references stay (they are the
   * merchant's financial records). The audit holds counts, never the identifiers.
   */
  async erase(merchantId: string, who: DataPrincipal, actor: Actor): Promise<ErasureCounts> {
    const vpa = who.vpa ? normVpa(who.vpa) : null;
    const phone = who.phone ? normPhone(who.phone) : null;
    if (who.phone !== undefined && phone === null) throw new AppError('VALIDATION', 'phone: expected 10 digits, optionally with +91');
    // Whole values only: erasing asha@okhdfc must never touch masha@okhdfc.
    const isVpa = (v: unknown) => vpa !== null && typeof v === 'string' && normVpa(v) === vpa;
    const isPhone = (v: unknown) => phone !== null && typeof v === 'string' && normPhone(v) === phone;
    const mentions = (v: unknown): boolean => {
      if (typeof v === 'string') return isVpa(v) || isPhone(v);
      if (v && typeof v === 'object') return Object.values(v).some(mentions);
      return false;
    };
    const scrub = (v: unknown): unknown => {
      if (typeof v === 'string') return isVpa(v) || isPhone(v) ? REDACTED : v;
      if (Array.isArray(v)) return v.map(scrub);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
      return v;
    };

    const { db, clock } = this.deps;
    const counts: ErasureCounts = { mandates: 0, payments: 0, checkoutSessions: 0, webhookDeliveries: 0 };

    await this.scan(mandates, mandates.id, mandates.merchantId, merchantId, { customerVpa: mandates.customerVpa }, async (rows) => {
      const ids = rows.filter((r) => isVpa(r.customerVpa)).map((r) => r.id);
      if (ids.length) await db.update(mandates).set({ customerVpa: REDACTED }).where(inArray(mandates.id, ids));
      counts.mandates += ids.length;
    });
    await this.scan(payments, payments.id, payments.merchantId, merchantId, { payerVpa: payments.payerVpa, customerAction: payments.customerAction }, async (rows) => {
      const ids = rows.filter((r) => isVpa(r.payerVpa) || mentions(r.customerAction)).map((r) => r.id);
      if (ids.length) await db.update(payments).set({ payerVpa: null, customerAction: null }).where(inArray(payments.id, ids));
      counts.payments += ids.length;
    });
    await this.scan(
      checkoutSessions,
      checkoutSessions.id,
      checkoutSessions.merchantId,
      merchantId,
      { customerPhone: checkoutSessions.customerPhone, customerVpa: checkoutSessions.customerVpa },
      async (rows) => {
        const ids = rows.filter((r) => isVpa(r.customerVpa) || isPhone(r.customerPhone)).map((r) => r.id);
        if (ids.length) await db.update(checkoutSessions).set({ customerPhone: null, customerVpa: null }).where(inArray(checkoutSessions.id, ids));
        counts.checkoutSessions += ids.length;
      },
    );
    await this.scan(webhookOutbox, webhookOutbox.id, webhookOutbox.merchantId, merchantId, { payload: webhookOutbox.payload }, async (rows) => {
      const hits = rows.filter((x) => mentions(x.payload));
      if (hits.length === 0) return;
      // One commit per batch, not per row.
      await db.transaction(async (tx) => {
        for (const r of hits) await tx.update(webhookOutbox).set({ payload: scrub(r.payload) }).where(eq(webhookOutbox.id, r.id));
      });
      counts.webhookDeliveries += hits.length;
    });

    await recordEvents(db, { merchantId, actor, now: clock.now() }, [{ type: 'DATA_ERASED', data: { ...counts } }]);
    return counts;
  }

  /** Visit one merchant's rows of a table in id order, BATCH at a time, with the given (decrypted) columns. */
  private async scan<F extends Record<string, PgColumn>>(
    table: PgTable,
    id: PgColumn,
    merchantCol: PgColumn,
    merchantId: string,
    fields: F,
    visit: (rows: Array<{ id: string } & { [K in keyof F]: unknown }>) => Promise<void>,
  ): Promise<void> {
    let after = '';
    for (;;) {
      const rows = (await this.deps.db
        .select({ id, ...fields })
        .from(table)
        .where(and(eq(merchantCol, merchantId), gt(id, after)))
        .orderBy(asc(id))
        .limit(BATCH)) as Array<{ id: string } & { [K in keyof F]: unknown }>;
      if (rows.length === 0) return;
      after = rows.at(-1)!.id;
      await visit(rows);
    }
  }
}

