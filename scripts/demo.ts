/**
 * Time-compressed simulation of the suite against mock PSPs.
 *
 *   npm run demo
 *
 * Scenario (all on 15 Oct 2026, the first day of the new MDR regime):
 *  1. A subscription business's billing cron fires 300 AutoPay debits at 10:00 AM —
 *     inside the NPCI morning embargo. PSP A is flaky; PSP B is healthy.
 *  2. 1,000 checkout carts are quoted; a share of customers take the steering offer.
 * Nothing here is real money or a real PSP. Mock behaviour is seeded and reproducible.
 */
import { asc, inArray } from 'drizzle-orm';
import { buildApp } from '../src/api/app.js';
import { FakeClock } from '../src/clock.js';
import { buildContext } from '../src/context.js';
import { createDb } from '../src/db/client.js';
import { debits, paymentAttempts } from '../src/db/schema.js';
import { MockPsp } from '../src/psp/mock.js';
import { configureMdrEffectiveFrom, DEFAULT_WINDOWS } from '../src/config/rules.js';
import { toIst } from '../src/rules/time.js';
import { isRestricted } from '../src/rules/windows.js';

const ADMIN = 'demo-admin-token-0000';
const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  // NPCI postponed the MDR start (no new date yet); the simulation assumes the announced date.
  configureMdrEffectiveFrom('2026-10-15');
  console.log('Assumption: UPI MDR in force from 15 Oct 2026 (as announced; NPCI has since postponed it).');
  const { db, close } = await createDb('pglite://memory');
  const clock = new FakeClock('2026-10-15T10:00:00+05:30');
  const pspA = new MockPsp('pspA', { seed: 7, rates: { bankUnavailable: 0.2, timeout: 0.08, timeoutActuallySucceeded: 0.5, businessDecline: 0.03 } });
  const pspB = new MockPsp('pspB', { seed: 11, rates: { bankUnavailable: 0.03, timeout: 0.02, businessDecline: 0.03 } });
  const ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: ADMIN, clock, sleep: clock.sleep });
  const app = buildApp(ctx);

  const post = async (url: string, body: unknown, token: string, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: 'POST', url, payload: body as object, headers: { authorization: `Bearer ${token}`, ...headers } });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
    return res.json();
  };

  const { apiKey } = await post('/v1/merchants', {
    name: 'StreamCo OTT',
    methodCosts: { NETBANKING: { percentBps: 0, flatPaise: 800 }, CARD: { percentBps: 180, flatPaise: 0 } },
  }, ADMIN);

  // ── 1. AutoPay ─────────────────────────────────────────────────────────────
  console.log('\n━━ Engine A + Smart Router: 300 AutoPay debits fired by billing cron at 10:00 AM IST ━━');
  const N = 300;
  let billed = 0;
  for (let i = 0; i < N; i++) {
    const mandate = await post('/v1/mandates', { mandateRef: `UMN-${i}`, customerVpa: `user${i}@okbank`, maxAmountPaise: 150000 }, apiKey);
    const amount = [14900, 49900, 64900, 149900][i % 4]!;
    billed += amount;
    await post(`/v1/mandates/${mandate.id}/debits`, { amountPaise: amount }, apiKey, { 'idempotency-key': `inv-${i}` });
  }
  console.log(`Intake: ${N} debits (${inr(billed)}) accepted at 10:00 AM, pre-debit notices sent: ${pspA.notices.length + pspB.notices.length}`);
  console.log('Naive baseline: firing now would hit the 10:00–13:00 embargo → every debit technically declined,');
  console.log('and blind same-window retries would exhaust mandate retry limits.');

  // Run the worker through simulated time, jumping to each next due slot.
  for (let guard = 0; guard < 10_000; guard++) {
    const [next] = await db
      .select({ at: debits.scheduledAt })
      .from(debits)
      .where(inArray(debits.state, ['SCHEDULED', 'PENDING_CONFIRMATION']))
      .orderBy(asc(debits.scheduledAt))
      .limit(1);
    if (!next) break;
    if (next.at > clock.now()) clock.set(next.at);
    await ctx.worker.runOnce();
  }

  const all = await db.select().from(debits);
  const attempts = await db.select().from(paymentAttempts);
  const executes = attempts.filter((a) => a.op === 'execute');
  const execTimesRestricted = all.filter((d) => d.completedAt && isRestricted(d.completedAt, DEFAULT_WINDOWS)).length;
  const byHour = new Map<string, number>();
  for (const d of all.filter((x) => x.completedAt)) {
    const t = toIst(d.completedAt!);
    const key = `${t.date} ${String(Math.floor(t.minutes / 60)).padStart(2, '0')}:00`;
    byHour.set(key, (byHour.get(key) ?? 0) + 1);
  }
  const ok = all.filter((d) => d.state === 'SUCCEEDED');
  const failed = all.filter((d) => d.state === 'FAILED');
  // Failed health probes are risks the router chose to take, not failures it rescued.
  const tdFailovers = new Set(executes.filter((a) => a.outcome === 'TECHNICAL_DECLINE' && !a.probe).map((a) => a.debitId)).size;
  const probes = executes.filter((a) => a.probe);

  console.log(`\nExecution spread (IST, completed debits):`);
  for (const [k, v] of [...byHour].sort()) console.log(`  ${k}  ${'█'.repeat(Math.ceil(v / 4))} ${v}`);
  console.log(`\nSucceeded: ${ok.length}/${N} (${inr(ok.reduce((s, d) => s + d.amountPaise, 0))})`);
  console.log(`Failed:    ${failed.length} → ${[...new Set(failed.map((d) => d.lastErrorCode))].join(', ') || '—'} (customer-side, correctly not retried)`);
  console.log(`Executions inside peak/blackout windows: ${execTimesRestricted}`);
  console.log(`Debits that hit a technical decline and were rescued by failover/retry: ${tdFailovers}`);
  console.log(`PSP calls: ${executes.length} execute, ${attempts.length - executes.length} status checks`);
  console.log(`Health probes of an avoided PSP: ${probes.length} (${probes.filter((a) => a.outcome === 'SUCCESS').length} succeeded)`);
  console.log(`PSP health:`, ctx.health.snapshot().map((s) => `${s.pspId}=${s.state} score ${s.score}`).join('  '));

  // ── 2. Checkout steering ───────────────────────────────────────────────────
  console.log('\n━━ Engine B: 1,000 checkout carts under the 0.4% MDR regime ━━');
  clock.set('2026-10-15T15:00:00+05:30');
  let seed = 2026;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let mdrIfAllUpi = 0;
  let mdrAfter = 0;
  let discounts = 0;
  let offers = 0;
  let taken = 0;
  for (let i = 0; i < 1000; i++) {
    const amount = Math.round((rand() < 0.7 ? 100 + rand() * 1900 : 2000 + rand() * 18000) * 100);
    const q = await post('/v1/checkout/quote', { amountPaise: amount }, apiKey);
    const upiCost = q.methods.find((m: { method: string }) => m.method === 'UPI').merchantCostPaise;
    mdrIfAllUpi += upiCost;
    if (q.offer) {
      offers++;
      if (rand() < 0.4) {
        taken++;
        await post(`/v1/checkout/quotes/${q.quoteId}/accept`, { method: q.offer.method }, apiKey);
        // The customer completes the steered payment; only then is the saving booked.
        await post(`/v1/checkout/quotes/${q.quoteId}/paid`, { method: q.offer.method, paymentReference: `nb-${i}` }, apiKey);
        const chosen = q.methods.find((m: { method: string }) => m.method === q.offer.method);
        mdrAfter += chosen.merchantCostPaise;
        discounts += q.offer.discountPaise;
        continue;
      }
    }
    mdrAfter += upiCost;
  }
  console.log(`Carts with a steering offer: ${offers}; customers who took it: ${taken} (assumed 40%)`);
  console.log(`Payment fees if everyone paid by UPI: ${inr(mdrIfAllUpi)}`);
  console.log(`Payment fees with steering:           ${inr(mdrAfter)} + ${inr(discounts)} customer discounts`);
  console.log(`Net saving for the merchant:          ${inr(mdrIfAllUpi - mdrAfter - discounts)}  (no customer was ever surcharged)`);

  // ── 3. Value report ────────────────────────────────────────────────────────
  const savings = (await app.inject({ method: 'GET', url: '/v1/savings', headers: { authorization: `Bearer ${apiKey}` } })).json();
  console.log('\n━━ /v1/savings — what the merchant sees ━━');
  console.log(`Revenue protected (peak rescues + TD recoveries): ${inr(savings.revenueProtectedPaise)}`);
  console.log(`MDR fees saved via steering:                      ${inr(savings.feesSavedPaise)}`);
  for (const [type, v] of Object.entries(savings.byType as Record<string, { count: number; amountPaise: number }>)) {
    console.log(`  ${type.padEnd(24)} ${String(v.count).padStart(5)} events  ${inr(v.amountPaise)}`);
  }

  await app.close();
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
