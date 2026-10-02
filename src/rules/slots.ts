import { addIstDays, fromIst, MINUTE_MS, toIst } from './time.js';
import { isRestricted, parseHm, type WindowConfig } from './windows.js';

/** Keep jittered slots this far from a window's end so execution latency can't spill into peak. */
const END_SAFETY_MS = 60_000;
const SEARCH_DAYS = 8;

/** FNV-1a 32-bit — stable, dependency-free hash for deterministic jitter. */
export function hashToInt(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick the execution instant for a deferred debit: the first preferred window that
 * ends after `earliest`, at a deterministic per-debit offset inside it. Spreading by
 * hash avoids every merchant firing at 13:01 and re-creating the spike NPCI is
 * trying to remove.
 */
export function chooseSlot(args: { earliest: Date; seed: string; cfg: WindowConfig }): Date {
  const { earliest, seed, cfg } = args;
  const slot = cfg.preferred.length > 0 ? fromPreferred(earliest, seed, cfg) : firstUnrestricted(earliest, cfg);
  if (isRestricted(slot, cfg)) {
    throw new Error(`Window config produced a restricted slot ${slot.toISOString()}; check preferred windows`);
  }
  return slot;
}

function fromPreferred(earliest: Date, seed: string, cfg: WindowConfig): Date {
  const windows = [...cfg.preferred].sort((a, b) => parseHm(a.start) - parseHm(b.start));
  const startDate = addIstDays(toIst(earliest).date, -1); // a wrapping window may have opened yesterday
  for (let day = 0; day <= SEARCH_DAYS; day++) {
    const date = addIstDays(startDate, day);
    for (const w of windows) {
      const s = parseHm(w.start);
      let e = parseHm(w.end);
      if (e <= s) e += 24 * 60;
      const winStart = fromIst(date, s).getTime();
      const winEnd = fromIst(date, e).getTime() - END_SAFETY_MS;
      const lo = Math.max(winStart, earliest.getTime());
      const range = winEnd - lo;
      if (range <= 0) continue;
      const offsetSec = hashToInt(seed) % Math.floor(range / 1000);
      return new Date(Math.ceil(lo / 1000) * 1000 + offsetSec * 1000);
    }
  }
  throw new Error('No preferred window found within search horizon');
}

function firstUnrestricted(earliest: Date, cfg: WindowConfig): Date {
  if (!isRestricted(earliest, cfg)) return earliest;
  let t = Math.ceil(earliest.getTime() / MINUTE_MS) * MINUTE_MS;
  const limit = t + SEARCH_DAYS * 24 * 60 * MINUTE_MS;
  while (t < limit) {
    if (!isRestricted(new Date(t), cfg)) return new Date(t);
    t += MINUTE_MS;
  }
  throw new Error('Every instant is restricted; check window config');
}
