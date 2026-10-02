import { toIst } from './time.js';

/** IST wall-clock window, "HH:MM" start inclusive, end exclusive. May wrap past midnight. */
export interface TimeWindow {
  start: string;
  end: string;
}

export interface WindowConfig {
  /** NPCI AutoPay execution embargo windows. */
  peak: TimeWindow[];
  /** Additional windows to avoid (e.g. bank CBS maintenance). */
  blackout: TimeWindow[];
  /** Windows deferred debits are spread across. Must not overlap peak/blackout. */
  preferred: TimeWindow[];
}

export function parseHm(hm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`Invalid HH:MM: ${hm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid HH:MM: ${hm}`);
  return h * 60 + min;
}

export function inWindow(minutes: number, w: TimeWindow): boolean {
  const s = parseHm(w.start);
  const e = parseHm(w.end);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export function isPeak(d: Date, cfg: WindowConfig): boolean {
  const { minutes } = toIst(d);
  return cfg.peak.some((w) => inWindow(minutes, w));
}

export function isRestricted(d: Date, cfg: WindowConfig): boolean {
  const { minutes } = toIst(d);
  return [...cfg.peak, ...cfg.blackout].some((w) => inWindow(minutes, w));
}
