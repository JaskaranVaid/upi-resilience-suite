/**
 * Load test against a running environment (docs/runbooks/load-testing.md).
 *
 * Onboards LOAD_MERCHANTS test-mode merchants (shared mock PSPs, never real money), then sends an
 * open-loop mix at LOAD_RPS requests per second for LOAD_DURATION_S seconds:
 *   35% checkout sessions · 20% one-off payments · 20% AutoPay debit requests · 25% reads.
 * Prints throughput, latency percentiles and outcomes; exits 1 if p95 or the error rate breach
 * LOAD_P95_MS / LOAD_MAX_ERROR_RATE.
 *
 *   LOAD_TARGET_ENV=staging LOAD_BASE_URL=https://api.staging.merchantflo.in LOAD_ADMIN_TOKEN=… npm run load:test
 *
 * Mind the limits: 1,200 requests/min per API key (so ≤ 20 rps per merchant) and the WAF's
 * per-IP rule (6,000 per 5 minutes ≈ 20 rps from one machine).
 */
import { checkThresholds, summarize, type Sample } from './load/stats.js';

const env = process.env;
const target = env.LOAD_TARGET_ENV ?? '';
const base = (env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const adminToken = env.LOAD_ADMIN_TOKEN ?? 'dev-admin-token-change-me';
const merchants = Number(env.LOAD_MERCHANTS ?? 5);
const rps = Number(env.LOAD_RPS ?? 20);
const durationS = Number(env.LOAD_DURATION_S ?? 60);
const maxInFlight = Number(env.LOAD_MAX_IN_FLIGHT ?? 200);
const thresholds = { p95Ms: Number(env.LOAD_P95_MS ?? 500), maxErrorRate: Number(env.LOAD_MAX_ERROR_RATE ?? 0.001) };

if (!['local', 'dev', 'staging'].includes(target)) {
  console.error('Set LOAD_TARGET_ENV to local, dev or staging. Load tests never run against production.');
  process.exit(2);
}

interface Tenant {
  key: string;
  mandateId: string;
}

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any; ms: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, ms: performance.now() - t0 };
  } catch {
    return { status: 0, json: null, ms: performance.now() - t0 };
  }
}

async function setup(run: string): Promise<Tenant[]> {
  const tenants: Tenant[] = [];
  for (let i = 0; i < merchants; i++) {
    const m = await call('POST', '/v1/merchants', adminToken, { name: `Load test ${run} #${i + 1}`, webhookUrl: 'https://example.com/merchantflo-load-test' });
    if (m.status !== 201) throw new Error(`onboarding failed: ${m.status} ${JSON.stringify(m.json)}`);
    const key: string = m.json.apiKey;
    const mandate = await call('POST', '/v1/mandates', key, { mandateRef: `LOAD-${run}-${i}`, customerVpa: `load${i}@okaxis`, maxAmountPaise: 1_000_000 });
    if (mandate.status !== 201) throw new Error(`mandate failed: ${mandate.status} ${JSON.stringify(mandate.json)}`);
    tenants.push({ key, mandateId: mandate.json.id });
  }
  return tenants;
}

// Whole-rupee amounts: paise 51–57 would trigger the test-mode failure scenarios.
const rupees = () => (100 + Math.floor(Math.random() * 1900)) * 100;
let seq = 0;

const SCENARIOS: Array<[weight: number, name: string, run: (t: Tenant, run: string) => Promise<{ status: number; ms: number }>]> = [
  [35, 'checkout-session', (t) => call('POST', '/v1/checkout/sessions', t.key, { amountPaise: rupees() })],
  [20, 'payment', (t, run) => call('POST', '/v1/payments', t.key, { amountPaise: rupees(), payerVpa: 'payer@okaxis', idempotencyKey: `load-${run}-p${++seq}` })],
  [20, 'debit', (t, run) => call('POST', `/v1/mandates/${t.mandateId}/debits`, t.key, { amountPaise: rupees(), idempotencyKey: `load-${run}-d${++seq}` })],
  [25, 'read', (t) => call('GET', '/v1/debits?limit=20', t.key)],
];
const totalWeight = SCENARIOS.reduce((s, [w]) => s + w, 0);

function pick() {
  let r = Math.random() * totalWeight;
  for (const s of SCENARIOS) if ((r -= s[0]) < 0) return s;
  return SCENARIOS[0]!;
}

async function main() {
  const run = Date.now().toString(36);
  console.log(`load test → ${base} (${target}): ${merchants} merchants, ${rps} rps for ${durationS}s`);
  const tenants = await setup(run);

  const samples: Sample[] = [];
  const pending = new Set<Promise<void>>();
  let skipped = 0;
  const started = performance.now();
  for (let i = 0; i < rps * durationS; i++) {
    // Open loop: requests start on schedule whether or not earlier ones have finished.
    const due = started + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (pending.size >= maxInFlight) {
      skipped++;
      continue;
    }
    const [, name, fn] = pick();
    const p = fn(tenants[i % tenants.length]!, run).then(({ status, ms }) => {
      samples.push({ ms: Math.round(ms), status, scenario: name });
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
  const summary = summarize(samples, performance.now() - started);
  console.log(JSON.stringify({ ...summary, skippedAtInFlightCap: skipped, thresholds }, null, 2));
  const breaches = checkThresholds(summary, thresholds);
  if (skipped > 0) breaches.push(`${skipped} requests not sent: ${maxInFlight} already in flight (the system could not keep up)`);
  if (breaches.length) {
    console.error(`FAILED: ${breaches.join('; ')}`);
    process.exit(1);
  }
  console.log('PASSED');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
