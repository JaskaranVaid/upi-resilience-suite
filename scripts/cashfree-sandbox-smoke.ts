/**
 * Cashfree SANDBOX smoke test — verifies the adapter against the real Cashfree test environment.
 * Never runs in CI and refuses to touch production.
 *
 *   npm run smoke:cashfree      (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET from .env or the shell)
 *
 * Optional steps (set the variables to enable them):
 *   SMOKE_UPI_ID + SMOKE_PHONE        UPI collect of ₹1 to a Cashfree sandbox test VPA, then poll its status
 *   SMOKE_SUBSCRIPTION_ID             send a pre-debit notification for an active sandbox UPI subscription
 *   SMOKE_SUBSCRIPTION_ID + SMOKE_EXECUTE_PAYMENT_ID
 *                                     execute a previously notified payment (≥ 25 h after notifying)
 * The script prints what to verify; it never prints credentials.
 */
import { randomBytes } from 'node:crypto';
import { loadDotEnv } from '../src/config/dotenv.js';
import { CashfreeAdapter } from '../src/psp/cashfree/adapter.js';
import { looksLikePlaceholder } from '../src/psp/factory.js';

loadDotEnv(); // credentials can live in .env (gitignored); shell variables still win

const env = process.env;
let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✘ ${msg}`);
};

async function main() {
  if (!env.CASHFREE_CLIENT_ID || !env.CASHFREE_CLIENT_SECRET) {
    console.log('Skipped: no Cashfree sandbox credentials found.');
    console.log('  Put them in a .env file in the project folder (it is gitignored):');
    console.log('    CASHFREE_CLIENT_ID=<your sandbox app id>');
    console.log('    CASHFREE_CLIENT_SECRET=<your sandbox secret key>');
    console.log('  then run: npm run smoke:cashfree');
    return;
  }
  const placeholders = (['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'] as const).filter((k) => looksLikePlaceholder(env[k]!));
  if (placeholders.length > 0) {
    console.error(`Not calling Cashfree: ${placeholders.join(' and ')} still look like placeholders (e.g. "<your sandbox app id>").`);
    console.error('  Use the real sandbox keys from the Cashfree dashboard (Test mode → Developers → API Keys).');
    console.error('  Variables set in this PowerShell window override .env; to clear them run:');
    console.error('    Remove-Item Env:CASHFREE_CLIENT_ID, Env:CASHFREE_CLIENT_SECRET');
    process.exitCode = 2;
    return;
  }
  if ((env.CASHFREE_ENV ?? 'sandbox') !== 'sandbox') {
    console.error('Refusing to run: this smoke test only runs against the Cashfree sandbox (CASHFREE_ENV=sandbox).');
    process.exitCode = 2;
    return;
  }
  const cf = new CashfreeAdapter({ clientId: env.CASHFREE_CLIENT_ID, clientSecret: env.CASHFREE_CLIENT_SECRET, env: 'sandbox' });
  const run = `smoke_${randomBytes(4).toString('hex')}`;
  console.log(`Cashfree sandbox smoke test (run ${run})`);

  console.log('1. Credentials & lookup path');
  try {
    const r = await cf.status(`${run}-unknown`, { kind: 'COLLECT' });
    r.kind === 'NOT_FOUND' ? ok('credentials accepted; unknown order → NOT_FOUND') : fail(`unexpected lookup result ${JSON.stringify(r)}`);
  } catch (e) {
    fail(`lookup failed: ${e instanceof Error ? e.message : e} (401 = wrong credentials or environment)`);
  }

  if (env.SMOKE_UPI_ID && env.SMOKE_PHONE) {
    console.log('2. UPI collect (₹1)');
    const txnRef = `${run}-collect`;
    const res = await cf.collect({ txnRef, payerVpa: env.SMOKE_UPI_ID, amountPaise: 100, customerPhone: env.SMOKE_PHONE });
    res.kind === 'PENDING' ? ok(`collect request sent (order ${txnRef})`) : fail(`collect returned ${JSON.stringify(res)} — check the x-client-* headers assumption`);
    for (let i = 0; i < 12 && res.kind === 'PENDING'; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      const s = await cf.status(txnRef, { kind: 'COLLECT' });
      console.log(`     status after ${(i + 1) * 10}s: ${JSON.stringify(s)}`);
      if (s.kind !== 'PENDING') {
        ok(`final status ${s.kind}`);
        console.log(`     inquiry: ${JSON.stringify(await cf.inquire(txnRef, { kind: 'COLLECT' }))}`);
        break;
      }
    }
  } else console.log('2. UPI collect — skipped (set SMOKE_UPI_ID to a Cashfree sandbox test VPA and SMOKE_PHONE)');

  if (env.SMOKE_SUBSCRIPTION_ID && !env.SMOKE_EXECUTE_PAYMENT_ID) {
    console.log('3. UPI AutoPay pre-debit notification');
    const paymentId = `${run}-debit`;
    // Two days out (IST): inside T+1..T+7 and clear of the 25 h execution gap.
    const executionDate = new Date(Date.now() + 2 * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const res = await cf.sendPreDebitNotice({ noticeRef: paymentId, mandateRef: env.SMOKE_SUBSCRIPTION_ID, amountPaise: 100, executionDate });
    if (res.ok) {
      ok(`notification sent for ${executionDate}`);
      console.log(`     After 25 h run again with SMOKE_EXECUTE_PAYMENT_ID=${paymentId} to execute it.`);
    } else fail(`notification refused: ${res.reason}`);
  } else if (env.SMOKE_SUBSCRIPTION_ID && env.SMOKE_EXECUTE_PAYMENT_ID) {
    console.log('3. UPI AutoPay execution');
    const ctx = { kind: 'MANDATE' as const, mandateRef: env.SMOKE_SUBSCRIPTION_ID, noticeRef: env.SMOKE_EXECUTE_PAYMENT_ID };
    const txnRef = `${env.SMOKE_EXECUTE_PAYMENT_ID}-a1-1`;
    const res = await cf.executeMandate({ txnRef, mandateRef: ctx.mandateRef, amountPaise: 100, noticeRef: ctx.noticeRef });
    console.log(`     execute → ${JSON.stringify(res)}`);
    console.log(`     status  → ${JSON.stringify(await cf.status(txnRef, ctx))}`);
    console.log('     Record the execution_status / payment_status strings you see: the adapter maps unknown ones to PENDING.');
  } else console.log('3. UPI AutoPay — skipped (set SMOKE_SUBSCRIPTION_ID to an active sandbox UPI subscription)');

  console.log(failures === 0 ? 'Smoke test passed.' : `Smoke test: ${failures} failure(s).`);
  // Set the exit code rather than calling process.exit(): exiting while fetch is still closing its
  // connection aborts Node on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
