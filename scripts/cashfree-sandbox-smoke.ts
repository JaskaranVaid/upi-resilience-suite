/**
 * Cashfree SANDBOX smoke test — verifies the adapter against the real Cashfree test environment.
 * Never runs in CI and refuses to touch production.
 *
 *   npm run smoke:cashfree      (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET from .env or the shell)
 *
 * Optional steps (set the variables to enable them):
 *   SMOKE_UPI_ID + SMOKE_PHONE        UPI collect of ₹1 to a Cashfree sandbox test VPA, then poll its status
 *   SMOKE_CREATE_SUBSCRIPTION=1       create a sandbox ON_DEMAND UPI subscription and authorise it with
 *                                     testsuccess@gocash (needs UPI AutoPay activated on the account)
 *   SMOKE_SUBSCRIPTION_ID             send a pre-debit notification for an active sandbox UPI subscription
 *   SMOKE_SUBSCRIPTION_ID + SMOKE_EXECUTE_PAYMENT_ID
 *                                     execute a previously notified payment (≥ 25 h after notifying)
 *   SMOKE_CHANNELS=1 + SMOKE_PHONE    create ₹1 UPI intent, UPI QR and card-checkout payments, print the actions
 *   SMOKE_RECON_DAY=YYYY-MM-DD        read that day's settlement report
 * The script prints what to verify; it never prints credentials.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { loadDotEnv } from '../src/config/dotenv.js';
import { CashfreeAdapter, CASHFREE_API_VERSION } from '../src/psp/cashfree/adapter.js';
import { requestJson } from '../src/psp/http.js';
import { looksLikePlaceholder } from '../src/psp/factory.js';

loadDotEnv(); // credentials can live in .env (gitignored); shell variables still win

const env = process.env;
let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✘ ${msg}`);
};

/**
 * Test-data setup, not part of the adapter (mandates are registered outside the suite): create an
 * ON_DEMAND UPI subscription in the sandbox and authorise it via Cashfree's success test VPA.
 */
async function createTestSubscription(run: string): Promise<string | null> {
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    requestJson((url, init) => fetch(url, init), {
      method,
      url: `https://sandbox.cashfree.com/pg${path}`,
      headers: {
        'content-type': 'application/json',
        'x-api-version': CASHFREE_API_VERSION,
        'x-client-id': env.CASHFREE_CLIENT_ID!,
        'x-client-secret': env.CASHFREE_CLIENT_SECRET!,
        'x-idempotency-key': randomUUID(),
      },
      ...(body === undefined ? {} : { body }),
      timeoutMs: 15_000,
    });
  const why = (r: { status: number; json: unknown }) => {
    const b = r.json as { code?: string; message?: string } | null;
    return `HTTP ${r.status}${b?.code ? ` ${b.code}` : ''}${b?.message ? `: ${b.message}` : ''}`;
  };
  const id = `${run}_sub`;
  const created = await call('POST', '/subscriptions', {
    subscription_id: id,
    customer_details: { customer_name: 'Smoke Test', customer_email: 'smoke-test@example.com', customer_phone: '9999999999' },
    plan_details: { plan_name: 'smoke on-demand', plan_type: 'ON_DEMAND', plan_max_amount: 1000, plan_currency: 'INR' },
    authorization_details: { authorization_amount: 1, authorization_amount_refund: true, payment_methods: ['upi'] },
    subscription_meta: { return_url: 'https://example.com/return' },
    subscription_expiry_time: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const sessionId = (created.json as { subscription_session_id?: string } | null)?.subscription_session_id;
  if (created.status !== 200 || !sessionId) {
    fail(`create subscription: ${why(created)}`);
    return null;
  }
  const auth = await call('POST', '/subscriptions/pay', {
    subscription_id: id,
    subscription_session_id: sessionId,
    payment_id: `${id}_auth`,
    payment_type: 'AUTH',
    payment_method: { upi: { channel: 'collect', upi_id: 'testsuccess@gocash' } },
  });
  if (auth.status !== 200) {
    fail(`authorise subscription: ${why(auth)}`);
    return null;
  }
  ok(`subscription ${id} created; authorisation requested from testsuccess@gocash`);
  let status = 'INITIALIZED';
  for (let i = 0; i < 12 && (status === 'INITIALIZED' || status === 'BANK_APPROVAL_PENDING'); i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await call('GET', `/subscriptions/${id}`);
    status = (s.json as { subscription_status?: string } | null)?.subscription_status ?? `unknown (${why(s)})`;
    console.log(`     status after ${(i + 1) * 10}s: ${status}`);
  }
  if (status !== 'ACTIVE') {
    fail(
      `subscription is ${status}, not ACTIVE. If it stays INITIALIZED, UPI AutoPay is not activated on this Cashfree ` +
        'account — it is not self-serve: ask Cashfree support to enable it for the sandbox (and production).',
    );
    return null;
  }
  ok('subscription ACTIVE');
  return id;
}

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
    const res = await cf.collect({ txnRef, channel: 'UPI_COLLECT', payerVpa: env.SMOKE_UPI_ID, amountPaise: 100, customerPhone: env.SMOKE_PHONE });
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

  if (env.SMOKE_CREATE_SUBSCRIPTION === '1' && !env.SMOKE_SUBSCRIPTION_ID) {
    console.log('3. UPI AutoPay test subscription');
    const id = await createTestSubscription(run);
    if (id) {
      console.log('     Next, send a pre-debit notification for it (PowerShell):');
      console.log(`       $env:SMOKE_SUBSCRIPTION_ID = "${id}"; npm run smoke:cashfree`);
    }
  } else if (env.SMOKE_SUBSCRIPTION_ID && !env.SMOKE_EXECUTE_PAYMENT_ID) {
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
  } else console.log('3. UPI AutoPay — skipped (SMOKE_CREATE_SUBSCRIPTION=1 creates a sandbox test subscription; SMOKE_SUBSCRIPTION_ID uses an active one)');

  if (env.SMOKE_PHONE && env.SMOKE_CHANNELS === '1') {
    console.log('4. Checkout channels (₹1 each): UPI intent, UPI QR, card checkout');
    for (const channel of ['UPI_INTENT', 'UPI_QR', 'CARD'] as const) {
      const res = await cf.collect({ txnRef: `${run}-${channel.toLowerCase()}`, channel, amountPaise: 100, customerPhone: env.SMOKE_PHONE });
      if (res.kind === 'PENDING' && res.action) ok(`${channel}: ${res.action.type} ${JSON.stringify(res.action).slice(0, 140)}`);
      else fail(`${channel} returned ${JSON.stringify(res)} — record the raw response shape in the runbook`);
    }
  } else console.log('4. Checkout channels — skipped (set SMOKE_CHANNELS=1 and SMOKE_PHONE)');

  if (env.SMOKE_RECON_DAY) {
    console.log(`5. Settlement report for ${env.SMOKE_RECON_DAY} (IST)`);
    try {
      const from = new Date(`${env.SMOKE_RECON_DAY}T00:00:00+05:30`);
      const lines = await cf.settlements({ from, to: new Date(from.getTime() + 86_400_000) });
      ok(`${lines.length} settlement line(s)${lines[0] ? `; first: ${JSON.stringify(lines[0])}` : ''}`);
    } catch (e) {
      fail(`settlement report: ${e instanceof Error ? e.message : e}`);
    }
  } else console.log('5. Settlement report — skipped (set SMOKE_RECON_DAY=YYYY-MM-DD)');

  console.log(failures === 0 ? 'Smoke test passed.' : `Smoke test: ${failures} failure(s).`);
  // Set the exit code rather than calling process.exit(): exiting while fetch is still closing its
  // connection aborts Node on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
