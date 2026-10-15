import { and, eq, inArray } from 'drizzle-orm';
import { ZodError } from 'zod';
import { createMandate } from '../api/schemas.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { mandates } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { PspRegistry } from '../psp/registry.js';
import type { PspAdapter } from '../psp/types.js';
import { resolveEligiblePsps } from './eligibility.js';

export const MAX_IMPORT_ROWS = 5_000;
const VERIFY_CONCURRENCY = 10;

export interface ImportResult {
  created: number;
  /** Already registered for this merchant (same mandateRef): left untouched, so re-imports are safe. */
  existing: number;
  /** Row numbers are 1-based over the submitted rows (for CSV: the line after the header). */
  rejected: Array<{ row: number; mandateRef: string | null; reason: string }>;
}

/** A CSV row's text cells → the JSON shape (eligiblePsps separated by | or ;). */
export function fromCsvRow(r: Record<string, string>): Record<string, unknown> {
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  return {
    mandateRef: r.mandateRef,
    customerVpa: r.customerVpa,
    maxAmountPaise: num(r.maxAmountPaise),
    ...(r.eligiblePsps ? { eligiblePsps: r.eligiblePsps.split(/[|;]/).map((s) => s.trim()).filter(Boolean) } : {}),
    ...(r.noAfaLimitPaise ? { noAfaLimitPaise: num(r.noAfaLimitPaise) } : {}),
  };
}

const reasonOf = (e: unknown) =>
  e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ') : e instanceof Error ? e.message : String(e);

/**
 * Bring existing UPI mandates (registered at the merchant's PSP before Merchantflo) into the
 * suite. Each row is validated on its own: one bad row never blocks the rest.
 */
export class MandateImporter {
  constructor(private readonly deps: { db: Db; clock: Clock; psps: PspRegistry }) {}

  async import(merchantId: string, rows: unknown[], opts: { verify: boolean }): Promise<ImportResult> {
    if (rows.length > MAX_IMPORT_ROWS) throw new AppError('VALIDATION', `At most ${MAX_IMPORT_ROWS} mandates per import`);
    const { db, clock, psps } = this.deps;
    const available = new Map((await psps.requireForMerchant(merchantId)).map((a) => [a.id, a]));
    const result: ImportResult = { created: 0, existing: 0, rejected: [] };

    // Validate every row first.
    type Valid = { row: number; mandate: ReturnType<typeof createMandate.parse>; eligiblePsps: string[] };
    const valid: Valid[] = [];
    const firstRowOf = new Map<string, number>();
    rows.forEach((raw, i) => {
      const row = i + 1;
      const ref = typeof (raw as { mandateRef?: unknown })?.mandateRef === 'string' ? (raw as { mandateRef: string }).mandateRef : null;
      try {
        const mandate = createMandate.parse(raw);
        const dup = firstRowOf.get(mandate.mandateRef);
        if (dup) throw new Error(`Duplicate of row ${dup}`);
        firstRowOf.set(mandate.mandateRef, row);
        valid.push({ row, mandate, eligiblePsps: resolveEligiblePsps(available, mandate.eligiblePsps) });
      } catch (e) {
        result.rejected.push({ row, mandateRef: ref, reason: reasonOf(e) });
      }
    });

    // Skip mandates this merchant already has.
    const known = new Set<string>();
    for (let i = 0; i < valid.length; i += 1000) {
      const refs = valid.slice(i, i + 1000).map((v) => v.mandate.mandateRef);
      const found = await db.select({ ref: mandates.mandateRef }).from(mandates).where(and(eq(mandates.merchantId, merchantId), inArray(mandates.mandateRef, refs)));
      for (const f of found) known.add(f.ref);
    }
    const fresh = valid.filter((v) => !known.has(v.mandate.mandateRef));
    result.existing = valid.length - fresh.length;

    // Optionally confirm each mandate is live at its PSP before accepting it.
    const accepted = opts.verify ? await this.verify(fresh, available, result) : fresh;

    const now = clock.now();
    for (let i = 0; i < accepted.length; i += 500) {
      const chunk = accepted.slice(i, i + 500);
      if (chunk.length === 0) continue;
      await db.insert(mandates).values(
        chunk.map((v) => ({ id: newId('mdt'), merchantId, ...v.mandate, eligiblePsps: v.eligiblePsps, createdAt: now })),
      );
    }
    result.created = accepted.length;
    result.rejected.sort((a, b) => a.row - b.row);
    return result;
  }

  private async verify<T extends { row: number; mandate: { mandateRef: string }; eligiblePsps: string[] }>(
    items: T[],
    available: ReadonlyMap<string, PspAdapter>,
    result: ImportResult,
  ): Promise<T[]> {
    const ok: T[] = [];
    const queue = [...items];
    const work = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const psp = available.get(item.eligiblePsps[0]!)!;
        if (!psp.mandateStatus) {
          ok.push(item); // the provider can't be asked; accepted as submitted
          continue;
        }
        try {
          const status = await psp.mandateStatus(item.mandate.mandateRef);
          if (status === 'ACTIVE') ok.push(item);
          else result.rejected.push({ row: item.row, mandateRef: item.mandate.mandateRef, reason: status === 'NOT_FOUND' ? `Not found at ${psp.id}` : `Not active at ${psp.id}` });
        } catch (e) {
          result.rejected.push({ row: item.row, mandateRef: item.mandate.mandateRef, reason: `Couldn't verify with ${psp.id} (try again): ${reasonOf(e)}` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, work));
    return ok.sort((a, b) => a.row - b.row);
  }
}
