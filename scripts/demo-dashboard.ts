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
import { buildContext } from '../src/context.js';
import { createDb } from '../src/db/client.js';
import { merchants, paymentTracking } from '../src/db/schema.js';
import { MockPsp } from '../src/psp/mock.js';
import type { PspResult, TransactionInquiry } from '../src/psp/types.js';

const PORT = Number(process.env.PORT ?? 3100);

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
  const { db, close } = await createDb('pglite://memory');
  const realNow = new Date();
  const clock = new DemoClock(new Date(realNow.getTime() - 8 * 24 * 3600_000));
  const pspA = new MockPsp('pspA', { seed: 3 });
  const pspB = new MockPsp('pspB', { seed: 5, complaintScript: ['IN_PROGRESS', 'IN_PROGRESS', 'RESOLVED_REVERSED'] });
  const ctx = buildContext({ db, adapters: [pspA, pspB], adminToken: 'demo-admin-token-0000', clock, sleep: clock.sleep });
  const app = buildApp(ctx);

  const m = await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: 'Bearer demo-admin-token-0000' }, payload: { name: 'StreamCo OTT' } });
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

  console.log('Seeding scenarios…');
  // Ordinary traffic.
  for (let i = 0; i < 18; i++) {
    await collect([49900, 129900, 250000, 79900, 499900][i % 5]!);
    clock.advance(37 * 60_000);
  }
  pspA.enqueue({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
  await collect(320000);

  // Pending at the PSP, confirmed a few checks later.
  pspA.enqueue(PENDING_TIMEOUT);
  pspA.scriptNextInquiry([
    { found: true, outcome: 'PENDING', customerDebit: 'UNKNOWN', capture: 'UNKNOWN', reversal: { status: 'NONE' } },
    { found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' } },
  ]);
  await poll((await collect(189900)).id);

  // Debited, not captured → bank auto-reversal completed.
  failBoth();
  pspB.scriptNextInquiry([debited(), debited({ status: 'INITIATED' }), debited({ status: 'COMPLETED' })]);
  await poll((await collect(275000)).id);

  // Debited, no reversal ever observed → verification budget exhausted → needs action.
  failBoth();
  pspB.scriptNextInquiry([debited()]);
  await poll((await collect(899900)).id);

  // Never resolved at the PSP → needs manual investigation.
  pspA.enqueue(PENDING_TIMEOUT);
  await poll((await collect(59900)).id);

  // PSP captured after we reported failure → status mismatch.
  failBoth();
  pspB.scriptNextInquiry([{ found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED', reversal: { status: 'NONE' } }]);
  await poll((await collect(1249900)).id);

  // AutoPay: one executed, one scheduled for the future.
  const mandate = await app.inject({ method: 'POST', url: '/v1/mandates', headers: { authorization: `Bearer ${apiKey}` }, payload: { mandateRef: 'UMN-DEMO-1', customerVpa: 'subscriber@okaxis', maxAmountPaise: 100000 } });
  const md = mandate.json().id as string;
  const d1 = await ctx.scheduler.createDebit(merchantId, md, { amountPaise: 49900, idempotencyKey: 'INV-2026-09', orderId: 'INV-2026-09' });
  clock.set(d1.debit.scheduledAt);
  await ctx.worker.runOnce();

  // Hand over to real time: a fresh debited payment the support user can work live,
  // plus a future-dated AutoPay debit.
  clock.goLive();
  await ctx.scheduler.createDebit(merchantId, md, { amountPaise: 49900, idempotencyKey: 'INV-2026-10', orderId: 'INV-2026-10' });
  failBoth();
  pspB.scriptNextInquiry([debited()]);
  const live = await collect(349900, 'ORD-LIVE-1');
  // Debited, not captured → the bank starts the auto-reversal on the first live check.
  failBoth();
  pspB.scriptNextInquiry([debited({ status: 'INITIATED' })]);
  await collect(149900, 'ORD-LIVE-2');

  const [merchant] = await db.select({ name: merchants.name }).from(merchants).where(eq(merchants.id, merchantId));
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const loop = setInterval(() => {
    void ctx.poller.runOnce().then(() => ctx.worker.runOnce()).catch((e) => console.error(e));
  }, 1000);

  console.log(`\n${merchant!.name} dashboard: http://localhost:${PORT}/dashboard/`);
  console.log('Demo users (local only):');
  for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(8)} ${u.email}  /  ${u.password}`);
  console.log(`\nTry: search ${live.id} or order ORD-LIVE-1, then raise a UDIR complaint (simulated).`);
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
  console.error(e);
  process.exit(1);
});
