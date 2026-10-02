import { getRuleSet } from '../config/rules.js';
import type { mandates } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Router } from '../routing/router.js';
import { chooseSlot } from '../rules/slots.js';
import { HOUR_MS, istDateString } from '../rules/time.js';

type Mandate = typeof mandates.$inferSelect;

export interface PlanningOptions {
  /** Extra margin on top of the regulatory notice period. */
  noticeBufferMs: number;
}

export const DEFAULT_PLANNING: PlanningOptions = { noticeBufferMs: 30 * 60_000 };

export interface Plan {
  scheduledAt: Date;
  noticeDate: string;
  /** True when a new pre-debit notice must be sent for noticeDate. */
  needsNotice: boolean;
}

/**
 * Decide when a debit runs. If a slot on the already-notified date is available at or
 * after `earliest`, use it. Otherwise move far enough out that a fresh notice satisfies
 * the RBI minimum notice period, and flag that the notice must be (re)sent.
 */
export function plan(args: {
  earliest: Date;
  now: Date;
  seed: string;
  noticeDate: string | null;
  opts: PlanningOptions;
}): Plan {
  const { earliest, now, seed, noticeDate, opts } = args;
  const rules = getRuleSet(now);
  if (noticeDate) {
    const slot = chooseSlot({ earliest, seed, cfg: rules.windows });
    if (istDateString(slot) === noticeDate) return { scheduledAt: slot, noticeDate, needsNotice: false };
  }
  const noticeReady = new Date(now.getTime() + rules.preDebitNoticeHours * HOUR_MS + opts.noticeBufferMs);
  const slot = chooseSlot({
    earliest: new Date(Math.max(earliest.getTime(), noticeReady.getTime())),
    seed,
    cfg: rules.windows,
  });
  return { scheduledAt: slot, noticeDate: istDateString(slot), needsNotice: true };
}

/** Pre-debit notices go via the mandate's primary PSP (the one the customer registered with). */
export async function sendNotice(router: Router, mandate: Mandate, debitId: string, amountPaise: number, executionDate: string) {
  const primary = mandate.eligiblePsps[0];
  if (!primary) throw new AppError('NOTICE_FAILED', 'Mandate has no PSP configured');
  let res;
  try {
    res = await router.adapter(primary).sendPreDebitNotice({
      noticeRef: debitId,
      mandateRef: mandate.mandateRef,
      amountPaise,
      executionDate,
    });
  } catch (e) {
    res = { ok: false as const, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) throw new AppError('NOTICE_FAILED', `Pre-debit notice failed: ${res.reason}`);
}
