import { z } from 'zod';
import { AppError } from '../errors.js';
import { addIstDays, istDateString, istMidnight } from '../rules/time.js';

export interface Period {
  /** Inclusive start instant. */
  from: Date;
  /** Exclusive end instant. */
  to: Date;
  /** 'YYYY-MM' for a calendar month (the billing cycle), null for a custom range. */
  month: string | null;
  label: string;
  /** IST calendar dates covered, for daily series. */
  days: string[];
}

export interface PeriodQuery {
  month?: string;
  from?: string;
  to?: string;
}

const MAX_DAYS = 366;
const monthLabel = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function daysBetween(from: Date, to: Date): string[] {
  const days: string[] = [];
  const last = istDateString(new Date(to.getTime() - 1));
  for (let d = istDateString(from); d <= last; d = addIstDays(d, 1)) days.push(d);
  return days;
}

/** A billing month (IST calendar month, default current) or a custom [from, to) range. */
export function resolvePeriod(q: PeriodQuery, now: Date): Period {
  if (q.month && (q.from || q.to)) throw new AppError('VALIDATION', 'Use either month or from/to, not both');

  if (q.from || q.to) {
    if (!q.from || !q.to) throw new AppError('VALIDATION', 'A custom range needs both from and to');
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new AppError('VALIDATION', 'Invalid date');
    if (to <= from) throw new AppError('VALIDATION', '"to" must be after "from"');
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw new AppError('VALIDATION', `A range can span at most ${MAX_DAYS} days`);
    const days = daysBetween(from, to);
    return { from, to, month: null, label: `${dayLabel.format(from)} – ${dayLabel.format(new Date(to.getTime() - 1))}`, days };
  }

  const month = q.month ?? istDateString(now).slice(0, 7);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new AppError('VALIDATION', 'Month must be YYYY-MM');
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
  const from = istMidnight(`${month}-01`);
  const to = istMidnight(`${next}-01`);
  return { from, to, month, label: monthLabel.format(new Date(Date.UTC(year, mon - 1, 1))), days: daysBetween(from, to) };
}

/** Query parameters naming a period: `month=YYYY-MM`, or `from` and `to` (ISO instants). */
export const periodQuery = z.object({
  month: z.string().max(7).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

/** The period a request asks for (default: the current IST billing month). */
export function periodFromQuery(query: unknown, now: Date): Period {
  const q = periodQuery.parse(query);
  return resolvePeriod({ ...(q.month ? { month: q.month } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }, now);
}

/** The period in a download's file name: `2026-10`, or `2026-10-01_2026-10-07` for a range. */
export const periodSpan = (p: Period): string => p.month ?? `${p.days[0]}_${p.days.at(-1)}`;
