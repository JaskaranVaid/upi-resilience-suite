import { describe, expect, it } from 'vitest';
import { classifyShadow, inRestrictedWindow } from '../../src/pilot/classify.js';
import { ist } from '../helpers/fixtures.js';

const OFF_PEAK = ist('2026-10-10T15:00:00');
const PEAK = ist('2026-10-10T18:30:00');
const BLACKOUT = ist('2026-10-10T23:45:00');
const row = (over: Partial<Parameters<typeof classifyShadow>[0]> = {}) => ({
  outcome: 'SUCCEEDED' as const,
  executedAt: OFF_PEAK,
  failureKind: null,
  wouldRefuse: null,
  ...over,
});

describe('shadow debit classification', () => {
  it('knows the NPCI restricted windows, and that they apply only from 1 Aug 2025', () => {
    expect(inRestrictedWindow(PEAK)).toBe(true);
    expect(inRestrictedWindow(BLACKOUT)).toBe(true);
    expect(inRestrictedWindow(OFF_PEAK)).toBe(false);
    expect(inRestrictedWindow(ist('2026-10-10T13:00:00'))).toBe(false); // the midday peak ends at 13:00
    expect(inRestrictedWindow(ist('2025-07-31T18:30:00'))).toBe(false);
    expect(inRestrictedWindow(ist('2025-08-01T18:30:00'))).toBe(true);
  });

  it('puts every reported execution in exactly one class', () => {
    expect(classifyShadow(row())).toBe('NO_CHANGE');
    expect(classifyShadow(row({ executedAt: PEAK }))).toBe('PEAK_RISK');
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'TECHNICAL', executedAt: PEAK }))).toBe('PEAK_RESCUE');
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'TECHNICAL', executedAt: BLACKOUT }))).toBe('PEAK_RESCUE');
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'TECHNICAL' }))).toBe('RETRY_RECOVERABLE');
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'BUSINESS', executedAt: PEAK }))).toBe('BUSINESS_DECLINE');
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'UNKNOWN', executedAt: PEAK }))).toBe('UNCLASSIFIED_FAILURE');
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'TECHNICAL', executedAt: PEAK, wouldRefuse: 'AFA_REQUIRED' }))).toBe('WOULD_REFUSE');
    expect(classifyShadow(row({ wouldRefuse: 'MANDATE_INACTIVE' }))).toBe('WOULD_REFUSE');
  });

  it('never credits a failure from before the peak rule existed as a peak rescue', () => {
    expect(classifyShadow(row({ outcome: 'FAILED', failureKind: 'TECHNICAL', executedAt: ist('2025-07-01T18:30:00') }))).toBe('RETRY_RECOVERABLE');
  });
});
