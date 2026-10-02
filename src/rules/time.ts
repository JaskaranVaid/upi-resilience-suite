/**
 * IST (Asia/Kolkata) wall-clock helpers. IST is a fixed UTC+05:30 with no DST,
 * so plain offset arithmetic is exact and independent of the host timezone.
 */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MINUTES = 24 * 60;

export interface IstWallClock {
  /** IST calendar date, YYYY-MM-DD */
  date: string;
  /** Minutes since IST midnight, fractional seconds included (0 <= m < 1440) */
  minutes: number;
}

export function toIst(d: Date): IstWallClock {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const date = shifted.toISOString().slice(0, 10);
  const minutes =
    shifted.getUTCHours() * 60 +
    shifted.getUTCMinutes() +
    shifted.getUTCSeconds() / 60 +
    shifted.getUTCMilliseconds() / MINUTE_MS;
  return { date, minutes };
}

export function istDateString(d: Date): string {
  return toIst(d).date;
}

/** The instant at which the given IST date begins. */
export function istMidnight(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${date}`);
  return new Date(t - IST_OFFSET_MS);
}

/** The instant at `minutes` past IST midnight of `date`. */
export function fromIst(date: string, minutes: number): Date {
  return new Date(istMidnight(date).getTime() + minutes * MINUTE_MS);
}

export function addIstDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 24 * HOUR_MS;
  return new Date(t).toISOString().slice(0, 10);
}
