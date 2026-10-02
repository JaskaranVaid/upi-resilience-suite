import { describe, expect, it } from 'vitest';
import { fromIst, istDateString, istMidnight, toIst } from '../../src/rules/time.js';
import { isPeak, isRestricted, parseHm } from '../../src/rules/windows.js';
import { DEFAULT_WINDOWS, getRuleSet } from '../../src/config/rules.js';

/** Build a Date from an IST wall-clock string, independent of host timezone. */
const ist = (s: string) => new Date(`${s}+05:30`);

describe('IST time helpers', () => {
  it('converts UTC instants to IST wall clock', () => {
    const t = toIst(new Date('2026-10-15T04:30:00Z')); // 10:00 IST
    expect(t).toEqual({ date: '2026-10-15', minutes: 600 });
  });

  it('rolls the IST date over before UTC does', () => {
    expect(istDateString(new Date('2026-10-15T19:00:00Z'))).toBe('2026-10-16'); // 00:30 IST
  });

  it('round-trips IST date + minutes', () => {
    expect(fromIst('2026-10-15', 13 * 60 + 1).toISOString()).toBe('2026-10-15T07:31:00.000Z');
    expect(istMidnight('2026-10-15').toISOString()).toBe('2026-10-14T18:30:00.000Z');
  });

  it('parses HH:MM', () => {
    expect(parseHm('21:30')).toBe(1290);
    expect(() => parseHm('25:00')).toThrow();
  });
});

describe('restricted windows (NPCI peak + bank blackout)', () => {
  const cases: Array<[string, boolean]> = [
    ['2026-10-15T09:59:59', false],
    ['2026-10-15T10:00:00', true],
    ['2026-10-15T10:30:00', true],
    ['2026-10-15T12:59:59', true],
    ['2026-10-15T13:00:00', false],
    ['2026-10-15T16:59:00', false],
    ['2026-10-15T17:00:00', true],
    ['2026-10-15T21:29:59', true],
    ['2026-10-15T21:30:00', false],
    ['2026-10-15T23:29:00', false],
    ['2026-10-15T23:45:00', true], // blackout, before midnight
    ['2026-10-16T00:15:00', true], // blackout wraps past midnight
    ['2026-10-16T00:30:00', false],
  ];
  it.each(cases)('%s IST restricted=%s', (s, expected) => {
    expect(isRestricted(ist(s), DEFAULT_WINDOWS)).toBe(expected);
  });

  it('distinguishes peak from blackout', () => {
    expect(isPeak(ist('2026-10-15T10:30:00'), DEFAULT_WINDOWS)).toBe(true);
    expect(isPeak(ist('2026-10-15T23:45:00'), DEFAULT_WINDOWS)).toBe(false);
  });
});

describe('rule set versioning', () => {
  it('uses zero-MDR rules before 15 Oct 2026 and reform rules after', () => {
    expect(getRuleSet(ist('2026-10-14T23:59:59')).mdr).toBeNull();
    expect(getRuleSet(ist('2026-10-15T00:00:00')).mdr?.generalBps).toBe(40);
  });
});
