import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/analytics/period.js';

const now = new Date('2026-10-15T08:00:00Z');

describe('resolvePeriod', () => {
  it('resolves a calendar month in IST', () => {
    const p = resolvePeriod({ month: '2026-10' }, now);
    expect(p.from.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(p.to.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(p.month).toBe('2026-10');
    expect(p.label).toBe('October 2026');
    expect(p.days).toHaveLength(31);
    expect(p.days[0]).toBe('2026-10-01');
    expect(p.days.at(-1)).toBe('2026-10-31');
  });

  it('defaults to the current IST month, which can differ from the UTC month', () => {
    expect(resolvePeriod({}, new Date('2026-10-31T19:00:00Z')).month).toBe('2026-11'); // 00:30 IST on 1 Nov
    expect(resolvePeriod({}, now).month).toBe('2026-10');
  });

  it('handles December → January', () => {
    const p = resolvePeriod({ month: '2026-12' }, now);
    expect(p.to.toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });

  it('resolves a custom range and lists the IST days it covers', () => {
    const p = resolvePeriod({ from: '2026-10-01T00:00:00+05:30', to: '2026-10-04T00:00:00+05:30' }, now);
    expect(p.month).toBeNull();
    expect(p.days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(p.label).toBe('1 Oct 2026 – 3 Oct 2026');
  });

  it.each([
    [{ month: '2026-13' }],
    [{ month: 'Oct 2026' }],
    [{ from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    [{ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    [{ from: '2026-10-01T00:00:00Z' }],
    [{ month: '2026-10', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }],
  ])('rejects %j', (q) => {
    expect(() => resolvePeriod(q, now)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
  });
});
