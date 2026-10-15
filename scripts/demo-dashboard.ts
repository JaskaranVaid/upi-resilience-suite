/**
 * Phase 3 demo: seeds realistic payment-investigation scenarios through the real services
 * (router, poller, worker, dispute service) against scripted MOCK PSPs, then serves the
 * merchant dashboard.
 *
 *   npm run demo:dashboard          → http://localhost:3100/dashboard/
 *
 * Seeding runs on a simulated clock (so 48h verification budgets elapse instantly); the
 * server then switches to real time, and the poller keeps resolving the live scenarios.
 * Everything uses in-memory Postgres and mock PSPs — no real money, PSP or NPCI involved.
 */
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/api/app.js';
import type { Clock } from '../src/clock.js';
import { choosePort, loadDotEnv } from '../src/config/dotenv.js';
import { configureMdrEffectiveFrom } from '../src/config/rules.js';
import { buildContext } from '../src/context.js';
import { createDb } from '../src/db/client.js';
import { merchants, paymentTracking } from '../src/db/schema.js';
import { MockPsp } from '../src/psp/mock.js';
import type { PspResult, TransactionInquiry } from '../src/psp/types.js';

loadDotEnv();
const REQUESTED_PORT = Number(process.env.PORT ?? 3100);

// Local demo credentials (dev only — never reuse elsewhere).
const DEMO_USERS = [
  { email: 'admin@streamco.example', name: 'Asha (Admin)', role: 'ADMIN', password: 'demo-admin-pass-2026' },
  { email: 'support@streamco.example', name: 'Ravi (Support)', role: 'SUPPORT', password: 'demo-support-pass-2026' },
  { email: 'viewer@streamco.example', name: 'Meera (Viewer)', role: 'VIEWER', password: 'demo-viewer-pass-2026' },
] as const;

/** Simulated time while seeding, real time afterwards. */
class DemoClock implements Clock {
  private simulated: number | null;
  constructor(start: Date) {
    this.simulated = start.getTime();
  }
  now() {
    return this.simulated === null ? new Date() : new Date(this.simulated);
  }
  set(d: Date) {
    this.simulated = d.getTime();
  }
  advance(ms: number) {
    if (this.simulated !== null) this.simulated += ms;
  }
  goLive() {
    this.simulated = null;
  }
  readonly sleep = async (ms: number) => {
    if (this.simulated === null) await new Promise((r) => setTimeout(r, ms));
    else this.simulated += ms;
  };
}

const BANK_DOWN: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
const PENDING_TIMEOUT = { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT', settleAs: { kind: 'PENDING' } } as const;
const debited = (reversal: Extract<TransactionInquiry, { found: true }>['reversal'] = { status: 'NONE' }): TransactionInquiry => ({
  found: true, outcome: 'FAILED', customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal,
});

async function main() {
  // Check the port before the (slow) seeding, so a busy port fails fast — or moves to a free one.
  const PORT = await choosePort(REQUESTED_PORT, { explicit: process.env.PORT !== undefined, host: '127.0.0.1' });
  if (PORT !== REQUESTED_PORT) console.log(`Port ${REQUESTED_PORT} is busy (another copy running?) — using ${PORT} instead.`);
  const { db, close } = await createDb('pglite://memory');
  const realNow = new Date();
  const HISTORY_DAYS = 30;
  // History (30 days) + settling (3 days) + scenarios (~4.5 days, two 48h budgets) must end before now.
  const clock = new DemoClock(new Date(realNow.getTime() - (HISTORY_DAYS + 10) * 24 * 3600_000));
  // Demo assumption: the MDR regime applies across the whole seeded history, so steering shows up.
  configureMdrEffectiveFrom(clock.now());
  console.log('Assumption: UPI MDR in force throughout the demo history (NPCI has postponed the real start date).');
  const COMPLAINT_SCRIPT = ['IN_PROGRESS', 'IN_PROGRESS', 'RESOLVED_REVERSED'] as const;
  // Constant simulated latencies (on the demo clock) so PSP performance shows realistic numbers.
  const pspA = new MockPsp('pspA', { seed: 3, latencyMs: 180, sleep: (ms) => clock.sleep(ms), complaintScript: [...COMPLAINT_SCRIPT] });
  const pspB = new MockPsp('pspB', { seed: 5, latencyMs: 120, sleep: (ms) => clock.sleep(ms), complaintScript: [...COMPLAINT_SCRIPT] });
  const ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: 'demo-admin-token-0000', clock, sleep: clock.sleep });
  const app = buildApp(ctx);

  const m = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { authorization: 'Bearer demo-admin-token-0000' },
    payload: { name: 'StreamCo OTT', methodCosts: { NETBANKING: { percentBps: 0, flatPaise: 800 }, CARD: { percentBps: 180, flatPaise: 0 } } },
  });
  const apiKey: string = m.json().apiKey;
  const merchantId: string = m.json().merchant.id;
  for (const u of DEMO_USERS) {
    await app.inject({ method: 'POST', url: '/v1/dashboard-users', headers: { authorization: `Bearer ${apiKey}` }, payload: u });
  }

  let n = 0;
  const collect = async (amountPaise: number, order = `ORD-${10_000 + ++n}`) =>
    (await ctx.payments.create(merchantId, { amountPaise, payerVpa: `customer${n}@okbank`, idempotencyKey: order, orderId: order })).payment;
  const trackingOf = async (id: string) => (await db.select().from(paymentTracking).where(eq(paymentTracking.subjectId, id)))[0]!;
  /** Run scheduled checks for one payment until it stops being watched (or `maxChecks`). */
  const poll = async (id: string, maxChecks = 500) => {
    for (let i = 0; i < maxChecks; i++) {
      const t = await trackingOf(id);
      if (t.verificationStatus !== 'IN_PROGRESS' || !t.nextCheckAt) return;
      clock.set(t.nextCheckAt);
      await ctx.poller.runOnce();
    }
  };
  const failBoth = () => {
    pspA.enqueue(BANK_DOWN);
    pspB.enqueue(BANK_DOWN);
  };

  // ── A month of ordinary traffic (feeds the Value pages) ─────────────────────────
  // PSP A is moderately unreliable, PSP B healthy; random but seeded, so runs are reproducible.
  console.log(`Seeding ${HISTORY_DAYS} days of history…`);
  pspA.setRates({ bankUnavailable: 0.07, timeout: 0.04, timeoutActuallySucceeded: 0.5, businessDecline: 0.03 });
  pspB.setRates({ bankUnavailable: 0.02, businessDecline: 0.03 });
  const histMandate = await app.inject({ method: 'POST', url: '/v1/mandates', headers: { authorization: `Bearer ${apiKey}` }, payload: { mandateRef: 'UMN-HIST', customerVpa: 'subscriber@okaxis', maxAmountPaise: 200000 } });
  const histMandateId = histMandate.json().id as string;
  const amounts = [49900, 129900, 250000, 79900, 499900, 189900, 34900, 999900];
  const cartAmounts = [150000, 320000, 540000, 899900, 1250000, 260000];
  let q = 0;
  // Steps cover the 13:00–17:00 off-peak window so deferred AutoPay debits execute on time.
  const steps = ['09:10', '11:20', '13:05', '14:15', '15:30', '16:59', '19:40', '22:10'];
  const firstDay = new Date(clock.now().getTime());
  for (let d = 0; d < HISTORY_DAYS; d++) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(firstDay.getTime() + d * 86_400_000));
    for (const [k, hm] of steps.entries()) {
      clock.set(new Date(`${date}T${hm}:00+05:30`));
      await ctx.worker.runOnce();
      await ctx.poller.runOnce();
      if (hm === '11:20') {
        // The billing cron fires inside the morning peak; the scheduler defers it.
        for (let j = 0; j < 2; j++) {
          await ctx.scheduler.createDebit(merchantId, histMandateId, { amountPaise: [49900, 149900][j]!, idempotencyKey: `INV-${date}-${j}`, orderId: `INV-${date}-${j}` });
        }
      }
      await collect(amounts[(d + k) % amounts.length]!);
      // A checkout quote; when a steering offer is shown, about 40% of customers take it.
      const quote = (await app.inject({ method: 'POST', url: '/v1/checkout/quote', headers: { authorization: `Bearer ${apiKey}` }, payload: { amountPaise: cartAmounts[(d + k) % cartAmounts.length] } })).json();
      if (quote.offer && ++q % 5 < 2) {
        await app.inject({ method: 'POST', url: `/v1/checkout/quotes/${quote.quoteId}/accept`, headers: { authorization: `Bearer ${apiKey}` }, payload: { method: quote.offer.method } });
      }
    }
  }
  // Let every history watch settle before the scripted scenarios, so none of them
  // consumes a scenario's scripted PSP response.
  for (let h = 0; h < 72; h++) {
    clock.advance(3600_000);
    await ctx.poller.runOnce();
  }
  pspA.setRates({});
  pspB.setRates({});

  console.log('Seeding scenarios…');
  // Scenarios must not depend on which PSP the router tries first (that depends on health,
  // which the history above has shaped). So: queue single-shot responses on the PSP the
  // router will try first, and script inquiries on the PSP + txnRef a payment actually ended on.
  const pspById = (id: string | null) => (id === 'pspB' ? pspB : pspA);
  const firstPsp = () => pspById(ctx.health.rank(['pspA', 'pspB'])[0] ?? 'pspA');
  const scriptFor = async (paymentId: string, steps: TransactionInquiry[]) => {
    const t = await trackingOf(paymentId);
    pspById(t.pspId).scriptInquiry(t.txnRef!, steps);
  };
  /** A collect that fails on infrastructure at every PSP, then reports the given facts. */
  const failedThen = async (amountPaise: number, steps: TransactionInquiry[], order?: string) => {
    failBoth();
    const p = await collect(amountPaise, order);
    await scriptFor(p.id, steps);
    return p;
  };

  // Ordinary traffic.
  for (let i = 0; i < 18; i++) {
    await collect([49900, 129900, 250000, 79900, 499900][i % 5]!);
    clock.advance(37 * 60_000);
  }
  firstPsp().enqueue({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
  await collect(320000);

  // Pending at the PSP, confirmed a few checks later.
  firstPsp().enqueue(PENDING_TIMEOUT);
  const pending = await collect(189900);
  await scriptFor(pending.id, [
    { found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: { status: 'NONE' } },
    { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' } },
  ]);
  await poll(pending.id);

  // Debited, not captured → bank auto-reversal completed.
  await poll((await failedThen(275000, [debited(), debited({ status: 'INITIATED' }), debited({ status: 'COMPLETED' })])).id);

  // Debited, no reversal ever observed → verification budget exhausted → needs action.
  await poll((await failedThen(899900, [debited()])).id);

  // Never resolved at the PSP → needs manual investigation.
  firstPsp().enqueue(PENDING_TIMEOUT);
  await poll((await collect(59900)).id);

  // PSP captured after we reported failure → status mismatch.
  await poll((await failedThen(1249900, [{ found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' } }])).id);

  // AutoPay: one executed, one scheduled for the future.
  const mandate = await app.inject({ method: 'POST', url: '/v1/mandates', headers: { authorization: `Bearer ${apiKey}` }, payload: { mandateRef: 'UMN-DEMO-1', customerVpa: 'subscriber@okaxis', maxAmountPaise: 100000 } });
  const md = mandate.json().id as string;
  const d1 = await ctx.scheduler.createDebit(merchantId, md, { amountPaise: 49900, idempotencyKey: 'INV-2026-09', orderId: 'INV-2026-09' });
  clock.set(d1.debit.scheduledAt);
  await ctx.worker.runOnce();

  // Hand over to real time: a fresh debited payment the support user can work live,
  // plus a future-dated AutoPay debit.
  if (clock.now() > realNow) console.warn('Warning: simulated seeding ran past real time; some records are future-dated.');
  clock.goLive();
  await ctx.scheduler.createDebit(merchantId, md, { amountPaise: 49900, idempotencyKey: 'INV-2026-10', orderId: 'INV-2026-10' });
  const live = await failedThen(349900, [debited()], 'ORD-LIVE-1');
  // Debited, not captured → the bank starts the auto-reversal on the first live check.
  await failedThen(149900, [debited({ status: 'INITIATED' })], 'ORD-LIVE-2');

  const [merchant] = await db.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, merchantId));
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const loop = setInterval(() => {
    void ctx.poller.runOnce().then(() => ctx.worker.runOnce()).catch((e) => console.error(e));
  }, 1000);

  console.log(`\n${merchant!.name} dashboard: http://localhost:${PORT}/dashboard/`);
  console.log('Demo users (local only):');
  for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email}  /  ${u.password}`);
  console.log(`\nTry: search ${live.id} or order ORD-LIVE-1, then raise a UDIR complaint (simulated).`);
  const historyMonth = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(realNow.getTime() - 20 * 86_400_000));
  console.log(`Value tab: ~${HISTORY_DAYS} days of history; pick ${historyMonth} for the fullest month.`);
  console.log('All PSP traffic is MOCK. Ctrl+C to stop.');

  const stop = async () => {
    clearInterval(loop);
    await app.close();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
