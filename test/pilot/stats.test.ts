import { describe, expect, it } from 'vitest';
import { differenceInterval, wilsonInterval } from '../../src/pilot/stats.js';

describe('confidence intervals', () => {
  it('Wilson score interval for one proportion', () => {
    // Newcombe (1998a), method 3: 81/263 → 0.2553 to 0.3662.
    const [lo, hi] = wilsonInterval(81, 263)!;
    expect(lo).toBeCloseTo(0.2553, 4);
    expect(hi).toBeCloseTo(0.3662, 4);
    expect(wilsonInterval(0, 10)![0]).toBe(0);
    expect(wilsonInterval(10, 10)![1]).toBeCloseTo(1, 10);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('Newcombe hybrid score interval for a difference of two proportions', () => {
    // Newcombe (1998b), method 10, worked examples.
    const a = differenceInterval(56, 70, 48, 80)!;
    expect(a.difference).toBeCloseTo(0.2, 10);
    expect(a.low).toBeCloseTo(0.0524, 4);
    expect(a.high).toBeCloseTo(0.3339, 4);
    const b = differenceInterval(9, 10, 3, 10)!;
    expect(b.low).toBeCloseTo(0.1705, 4);
    expect(b.high).toBeCloseTo(0.809, 3);
    expect(differenceInterval(1, 1, 0, 0)).toBeNull();
  });
});
