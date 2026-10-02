import { describe, expect, it } from 'vitest';
import { DEFAULT_POLLING } from '../../src/config/polling.js';
import { checkTimesMs, nextCheckAt } from '../../src/tracking/schedule.js';

const start = new Date('2026-10-15T08:00:00Z');
const at = (ms: number) => new Date(start.getTime() + ms);
const S = 1000;
const M = 60 * S;
const H = 60 * M;

describe('polling schedule', () => {
  it('starts with checks at 5s, 15s, 30s and 45s', () => {
    expect(checkTimesMs(DEFAULT_POLLING).slice(0, 4)).toEqual([5 * S, 15 * S, 30 * S, 45 * S]);
  });

  it('then checks every minute until 15 minutes, then every 15 minutes', () => {
    const times = checkTimesMs(DEFAULT_POLLING);
    const fast = times.filter((t) => t > 45 * S && t <= 16 * M);
    expect(fast.slice(0, 3)).toEqual([105 * S, 165 * S, 225 * S]);
    for (let i = 1; i < fast.length; i++) expect(fast[i]! - fast[i - 1]!).toBe(M);
    const slow = times.filter((t) => t > 16 * M);
    for (let i = 1; i < slow.length; i++) expect(slow[i]! - slow[i - 1]!).toBe(15 * M);
  });

  it('never schedules beyond the 48 hour budget', () => {
    const times = checkTimesMs(DEFAULT_POLLING);
    expect(Math.max(...times)).toBeLessThanOrEqual(48 * H);
    expect(times.length).toBeLessThan(250);
  });

  it('returns the first scheduled check strictly after now', () => {
    expect(nextCheckAt(start, start, DEFAULT_POLLING)).toEqual(at(5 * S));
    expect(nextCheckAt(start, at(5 * S), DEFAULT_POLLING)).toEqual(at(15 * S));
    expect(nextCheckAt(start, at(20 * S), DEFAULT_POLLING)).toEqual(at(30 * S));
    expect(nextCheckAt(start, at(50 * S), DEFAULT_POLLING)).toEqual(at(105 * S));
  });

  it('is unaffected by extra manual checks (it is time-based, not count-based)', () => {
    expect(nextCheckAt(start, at(6 * S), DEFAULT_POLLING)).toEqual(at(15 * S));
    expect(nextCheckAt(start, at(7 * S), DEFAULT_POLLING)).toEqual(at(15 * S));
  });

  it('returns null once the budget is exhausted', () => {
    expect(nextCheckAt(start, at(48 * H), DEFAULT_POLLING)).toBeNull();
    expect(nextCheckAt(start, at(48 * H + 1), DEFAULT_POLLING)).toBeNull();
  });

  it('honours maxChecks when configured', () => {
    const cfg = { ...DEFAULT_POLLING, maxChecks: 2 };
    expect(checkTimesMs(cfg)).toEqual([5 * S, 15 * S]);
    expect(nextCheckAt(start, at(15 * S), cfg)).toBeNull();
  });

  it('uses whatever intervals are configured', () => {
    const cfg = { ...DEFAULT_POLLING, initialOffsetsMs: [1 * S], fastIntervalMs: 2 * S, fastPhaseUntilMs: 6 * S, slowIntervalMs: 10 * S, maxDurationMs: 30 * S };
    expect(checkTimesMs(cfg)).toEqual([1 * S, 3 * S, 5 * S, 7 * S, 17 * S, 27 * S]);
  });
});
