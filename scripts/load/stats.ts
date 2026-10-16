/** One request: how long it took, its HTTP status (0 = network error or timeout) and its scenario. */
export interface Sample {
  ms: number;
  status: number;
  scenario: string;
}

interface Outcomes {
  requests: number;
  /** Anything but 2xx, except 429 (rate limiting is the API working as designed). */
  errors: number;
  rateLimited: number;
  p95: number;
}

export interface Summary extends Outcomes {
  durationS: number;
  rps: number;
  p50: number;
  p99: number;
  max: number;
  errorRate: number;
  byScenario: Record<string, Outcomes>;
}

/** Nearest-rank percentile of ascending values (0 for none). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
}

function outcomes(samples: Sample[]): Outcomes & { sorted: number[] } {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return {
    requests: samples.length,
    errors: samples.filter((s) => (s.status < 200 || s.status > 299) && s.status !== 429).length,
    rateLimited: samples.filter((s) => s.status === 429).length,
    p95: percentile(sorted, 95),
    sorted,
  };
}

export function summarize(samples: Sample[], durationMs: number): Summary {
  const { sorted, ...all } = outcomes(samples);
  const byScenario: Record<string, Outcomes> = {};
  for (const name of new Set(samples.map((s) => s.scenario))) {
    const { sorted: _, ...o } = outcomes(samples.filter((s) => s.scenario === name));
    byScenario[name] = o;
  }
  return {
    ...all,
    durationS: durationMs / 1000,
    rps: Math.round((samples.length / (durationMs / 1000)) * 100) / 100,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    errorRate: samples.length ? all.errors / samples.length : 0,
    byScenario,
  };
}

export interface Thresholds {
  p95Ms: number;
  /** Fraction, e.g. 0.001 for 0.1 %. */
  maxErrorRate: number;
}

/** What the run breached; empty when it passed. */
export function checkThresholds(s: Summary, t: Thresholds): string[] {
  if (s.requests === 0) return ['no requests completed'];
  const breaches: string[] = [];
  if (s.p95 > t.p95Ms) breaches.push(`p95 ${s.p95} ms > ${t.p95Ms} ms`);
  if (s.errorRate > t.maxErrorRate) breaches.push(`error rate ${(s.errorRate * 100).toFixed(2)}% > ${(t.maxErrorRate * 100).toFixed(2)}%`);
  return breaches;
}
