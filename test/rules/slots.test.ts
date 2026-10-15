import { describe, expect, it } from 'vitest';
import { chooseSlot } from '../../src/rules/slots.js';
import { isRestricted, inWindow } from '../../src/rules/windows.js';
import { toIst } from '../../src/rules/time.js';
import { DEFAULT_WINDOWS } from '../../src/config/rules.js';

const ist = (s: string) => new Date(`${s}+05:30`);
const inPreferred = (d: Date) => DEFAULT_WINDOWS.preferred.some((w) => inWindow(toIst(d).minutes, w));

describe('chooseSlot', () => {
  it('defers a 10:30 AM request into the same-day 13:00-17:00 window', () => {
    const slot = chooseSlot({ earliest: ist('2026-10-15T10:30:00'), seed: 'debit-1', cfg: DEFAULT_WINDOWS });
    expect(slot.getTime()).toBeGreaterThanOrEqual(ist('2026-10-15T13:00:00').getTime());
    expect(slot.getTime()).toBeLessThan(ist('2026-10-15T17:00:00').getTime());
  });

  it('rolls an evening request to the next day', () => {
    const slot = chooseSlot({ earliest: ist('2026-10-15T18:00:00'), seed: 'debit-1', cfg: DEFAULT_WINDOWS });
    expect(toIst(slot).date).toBe('2026-10-16');
    expect(inPreferred(slot)).toBe(true);
  });

  it('never schedules before earliest when earliest is inside the preferred window', () => {
    const earliest = ist('2026-10-15T16:30:00');
    const slot = chooseSlot({ earliest, seed: 'x', cfg: DEFAULT_WINDOWS });
    expect(slot.getTime()).toBeGreaterThanOrEqual(earliest.getTime());
    expect(slot.getTime()).toBeLessThan(ist('2026-10-15T17:00:00').getTime());
  });

  it('moves to the next window when less than a second of the current one is usable', () => {
    // The usable window ends at 16:59:00 (60 s safety margin); half a second remains.
    const slot = chooseSlot({ earliest: ist('2026-10-15T16:58:59.500'), seed: 'debit-edge', cfg: DEFAULT_WINDOWS });
    expect(Number.isNaN(slot.getTime())).toBe(false);
    expect(toIst(slot).date).toBe('2026-10-16');
    expect(inPreferred(slot)).toBe(true);
  });

  it('is deterministic per seed', () => {
    const a = chooseSlot({ earliest: ist('2026-10-15T10:30:00'), seed: 'debit-42', cfg: DEFAULT_WINDOWS });
    const b = chooseSlot({ earliest: ist('2026-10-15T10:30:00'), seed: 'debit-42', cfg: DEFAULT_WINDOWS });
    expect(a.getTime()).toBe(b.getTime());
  });

  it('spreads different debits across the window instead of a 13:01 thundering herd', () => {
    const earliest = ist('2026-10-15T10:30:00');
    const slots = Array.from({ length: 500 }, (_, i) =>
      chooseSlot({ earliest, seed: `debit-${i}`, cfg: DEFAULT_WINDOWS }),
    );
    const hourBuckets = new Set(slots.map((s) => Math.floor(toIst(s).minutes / 60)));
    expect(hourBuckets).toEqual(new Set([13, 14, 15, 16]));
    const inFirstMinute = slots.filter((s) => toIst(s).minutes < 13 * 60 + 1).length;
    expect(inFirstMinute).toBeLessThan(10);
  });

  it('falls back to the nearest unrestricted instant when no preferred windows are configured', () => {
    const cfg = { ...DEFAULT_WINDOWS, preferred: [] };
    const slot = chooseSlot({ earliest: ist('2026-10-15T10:30:00'), seed: 'x', cfg });
    expect(slot.toISOString()).toBe(ist('2026-10-15T13:00:00').toISOString());
  });

  it('sweep: slots are always >= earliest, unrestricted and inside a preferred window', () => {
    const start = ist('2026-10-12T00:00:00').getTime();
    for (let m = 0; m < 8 * 24 * 60; m += 7) {
      const earliest = new Date(start + m * 60_000);
      const slot = chooseSlot({ earliest, seed: `s${m}`, cfg: DEFAULT_WINDOWS });
      expect(slot.getTime()).toBeGreaterThanOrEqual(earliest.getTime());
      expect(isRestricted(slot, DEFAULT_WINDOWS)).toBe(false);
      expect(inPreferred(slot)).toBe(true);
      expect(slot.getTime() - earliest.getTime()).toBeLessThan(2 * 24 * 3600_000);
    }
  });
});
