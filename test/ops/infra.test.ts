import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPS_METRIC_NAMES } from '../../src/ops/metrics.js';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('infrastructure stays in step with the code', () => {
  const monitoring = read('infra/modules/monitoring/main.tf');

  it('turns every ops.metrics field into a CloudWatch metric, and nothing else', () => {
    const block = /ops_metrics = \[([^\]]*)\]/.exec(monitoring)?.[1] ?? '';
    const names = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(names).toEqual([...OPS_METRIC_NAMES]);
  });

  it('alarms only on metrics the worker emits', () => {
    const alarmed = [...monitoring.matchAll(/metric\s+= "(\w+)", comparison/g)].map((m) => m[1]!);
    expect(alarmed.length).toBeGreaterThanOrEqual(9);
    for (const m of alarmed) expect(OPS_METRIC_NAMES as readonly string[]).toContain(m);
  });

  it('matches the log line the worker writes', () => {
    expect(monitoring).toContain('pattern        = "{ $.msg = \\"ops.metrics\\" }"');
  });

  it('checks api targets on the readiness probe and runs the container health check', () => {
    expect(read('infra/modules/edge/main.tf')).toMatch(/path\s+= "\/readyz"/);
    expect(read('infra/modules/service/main.tf')).toContain('"node", "dist/ops/healthcheck.js"');
  });
});
