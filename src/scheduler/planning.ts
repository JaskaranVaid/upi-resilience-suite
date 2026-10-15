import { getRuleSet } from '../config/rules.js';
import type { mandates } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Router } from '../routing/router.js';
import { chooseSlot } from '../rules/slots.js';
import { addIstDays, HOUR_MS, istDateString, istMidnight } from '../rules/time.js';

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
  /** The provider's own minimum notice, when stricter than the regulatory one. */
  minNoticeMs?: number;
}): Plan {
  const { earliest, now, seed, noticeDate, opts } = args;
  const rules = getRuleSet(now);
  if (noticeDate) {
    const slot = chooseSlot({ earliest, seed, cfg: rules.windows });
    if (istDateString(slot) === noticeDate) return { scheduledAt: slot, noticeDate, needsNotice: false };
  }
  const minNotice = Math.max(rules.preDebitNoticeHours * HOUR_MS, args.minNoticeMs ?? 0);
  const noticeReady = new Date(now.getTime() + minNotice + opts.noticeBufferMs);
  const slot = chooseSlot({
    earliest: new Date(Math.max(earliest.getTime(), noticeReady.getTime())),
    seed,
    cfg: rules.windows,
  });
  return { scheduledAt: slot, noticeDate: istDateString(slot), needsNotice: true };
}

export interface NoticeWindow {
  minNoticeMs: number;
  maxNoticeLeadMs: number | null;
}

/** The notice window of the PSP that sends this mandate's notices (its primary PSP). */
export function noticeWindow(router: Router, mandate: Mandate): NoticeWindow {
  const primary = mandate.eligiblePsps[0];
  try {
    const caps = primary ? router.adapter(primary).capabilities : null;
    return { minNoticeMs: caps?.minNoticeMs ?? 0, maxNoticeLeadMs: caps?.maxNoticeLeadMs ?? null };
  } catch {
    return { minNoticeMs: 0, maxNoticeLeadMs: null };
  }
}

/**
 * If the planned execution is further ahead than the provider accepts notices for, return when
 * to send the notice instead (an off-peak moment inside the provider's window); else null.
 *
 * When the notice is sent, the execution is re-planned and may land at any off-peak time on the
 * same date, so the notice is timed against the *end* of the execution date: every slot on that
 * date is then within the provider's lead limit, and the notice is never deferred twice.
 */
export function deferredNoticeAt(slot: Date, now: Date, win: NoticeWindow, seed: string): Date | null {
  if (win.maxNoticeLeadMs === null || slot.getTime() - now.getTime() <= win.maxNoticeLeadMs) return null;
  const rules = getRuleSet(now);
  const dateEnd = istMidnight(addIstDays(istDateString(slot), 1)).getTime();
  return chooseSlot({ earliest: new Date(dateEnd - win.maxNoticeLeadMs + HOUR_MS), seed: `${seed}:notice`, cfg: rules.windows });
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
