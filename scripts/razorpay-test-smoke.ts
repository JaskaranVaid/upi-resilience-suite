/**
 * Razorpay TEST-mode smoke test — verifies the adapter against Razorpay with rzp_test_ keys.
 * Never runs in CI and refuses live keys.
 *
 *   npm run smoke:razorpay      (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from .env or the shell)
 *
 * Optional steps:
 *   SMOKE_PHONE                     create ₹1 UPI intent and card-checkout payments (S2S UPI must be
 *                                   enabled on the account), then read their status
 *   SMOKE_RECON_DAY=YYYY-MM-DD      read that day's settlement recon report
 * The script prints what to verify; it never prints credentials.
 */
import { randomBytes } from 'node:crypto';
import { loadDotEnv } from '../src/config/dotenv.js';
import { looksLikePlaceholder } from '../src/psp/factory.js';
import { RazorpayAdapter } from '../src/psp/razorpay/adapter.js';

loadDotEnv();

const env = process.env;
let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  ✘ ${msg}`);
};

async function main() {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.log('Skipped: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test-mode keys) in .env, then run npm run smoke:razorpay');
    return;
  }
  if (looksLikePlaceholder(keyId) || looksLikePlaceholder(keySecret)) {
    console.error('Not calling Razorpay: the keys still look like placeholders.');
    process.exitCode = 2;
    return;
  }
  if (!keyId.startsWith('rzp_test_')) {
    console.error('Refusing to run: this smoke test only uses Razorpay TEST keys (rzp_test_…).');
    process.exitCode = 2;
    return;
  }
  const rzp = new RazorpayAdapter({ id: 'razorpay-smoke', keyId, keySecret });
  const run = `smoke_${randomBytes(4).toString('hex')}`;
  console.log(`Razorpay test-mode smoke test (run ${run})`);

  console.log('1. Credentials');
  const check = await rzp.checkCredentials();
  check.ok ? ok('keys accepted') : fail(check.reason);

  if (env.SMOKE_PHONE) {
    console.log('2. Payments (₹1): UPI intent, card checkout');
    for (const channel of ['UPI_INTENT', 'CARD'] as const) {
      const txnRef = `${run}-${channel.toLowerCase()}`;
      const res = await rzp.collect({ txnRef, channel, amountPaise: 100, customerPhone: env.SMOKE_PHONE });
      if (res.kind === 'PENDING' && res.action) ok(`${channel}: ${res.action.type} ${JSON.stringify(res.action).slice(0, 140)}`);
      else fail(`${channel} returned ${JSON.stringify(res)} (S2S UPI must be enabled on the account for intent)`);
      try {
        console.log(`     status: ${JSON.stringify(await rzp.status(txnRef, { kind: 'COLLECT' }))}`);
      } catch (e) {
        fail(`status lookup: ${e instanceof Error ? e.message : e}`);
      }
    }
  } else console.log('2. Payments — skipped (set SMOKE_PHONE)');

  if (env.SMOKE_RECON_DAY) {
    console.log(`3. Settlement recon for ${env.SMOKE_RECON_DAY} (IST)`);
    try {
      const from = new Date(`${env.SMOKE_RECON_DAY}T00:00:00+05:30`);
      const lines = await rzp.settlements({ from, to: new Date(from.getTime() + 86_400_000) });
      ok(`${lines.length} settlement line(s)${lines[0] ? `; first: ${JSON.stringify(lines[0])}` : ''}`);
    } catch (e) {
      fail(`settlement report: ${e instanceof Error ? e.message : e}`);
    }
  } else console.log('3. Settlement recon — skipped (set SMOKE_RECON_DAY=YYYY-MM-DD)');

  console.log(failures === 0 ? 'Smoke test passed.' : `Smoke test: ${failures} failure(s).`);
  process.exitCode = failures === 0 ? 0 : 1; // not process.exit(): see the Cashfree smoke test (Windows)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
