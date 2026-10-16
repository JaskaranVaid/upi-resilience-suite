import { describe, expect, it } from 'vitest';
import { checkThresholds, percentile, summarize, type Sample } from '../../scripts/load/stats.js';

const ok = (ms: number, scenario = 'read'): Sample => ({ ms, status: 200, scenario });

describe('load test statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile(xs, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });

  it('summarizes throughput, latency and outcomes, counting rate limiting apart from errors', () => {
    const samples: Sample[] = [
      ...Array.from({ length: 96 }, (_, i) => ok(10 + i)),
      { ms: 30, status: 500, scenario: 'write' },
      { ms: 5000, status: 0, scenario: 'write' }, // network error / timeout
      { ms: 12, status: 429, scenario: 'write' },
      { ms: 14, status: 400, scenario: 'write' },
    ];
    const s = summarize(samples, 10_000);
    expect(s).toMatchObject({ requests: 100, rps: 10, errors: 3, rateLimited: 1, errorRate: 0.03, max: 5000 });
    expect(s.byScenario.write).toMatchObject({ requests: 4, errors: 3, rateLimited: 1 });
    expect(s.byScenario.read).toMatchObject({ requests: 96, errors: 0 });
  });

  it('measures latency on every request, failures included', () => {
    const s = summarize([ok(10), ok(20), { ms: 3000, status: 503, scenario: 'read' }], 1000);
    expect(s.p99).toBe(3000);
  });

  it('lists each threshold breached', () => {
    const s = summarize([ok(100), ok(900), { ms: 50, status: 500, scenario: 'read' }], 1000);
    expect(checkThresholds(s, { p95Ms: 1000, maxErrorRate: 0.5 })).toEqual([]);
    expect(checkThresholds(s, { p95Ms: 500, maxErrorRate: 0.01 })).toEqual(['p95 900 ms > 500 ms', 'error rate 33.33% > 1.00%']);
  });

  it('fails a run that made no requests', () => {
    expect(checkThresholds(summarize([], 1000), { p95Ms: 500, maxErrorRate: 0.01 })).toEqual(['no requests completed']);
  });
});
