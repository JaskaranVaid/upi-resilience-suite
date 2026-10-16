/**
 * Seal customers' personal fields that are still in plaintext (rows from before encryption) and
 * re-seal those under an older key after CREDENTIALS_KEYS rotates. Safe to re-run and to run
 * while the service is live. In AWS run it as a one-off ECS task on the production image:
 * `node dist/cli/privacy-backfill.js` (docs/runbooks/operators.md).
 *
 *   npm run privacy:backfill [-- --batch 500]
 */
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../config/dotenv.js';
import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { privacyBackfill } from '../privacy/backfill.js';
import { configureFieldEncryption } from '../security/fields.js';
import { SecretBox } from '../security/secrets.js';

async function main() {
  const { values } = parseArgs({ options: { batch: { type: 'string', default: '500' } } });
  loadDotEnv();
  const env = loadEnv();
  if (env.ENCRYPT_PERSONAL_FIELDS !== 'true') throw new Error('ENCRYPT_PERSONAL_FIELDS is off — nothing to backfill');
  configureFieldEncryption({ box: SecretBox.fromEnv(env.CREDENTIALS_KEYS, env.NODE_ENV), enabled: true });
  const { db, close } = await createDb(env.DATABASE_URL, { migrate: env.MIGRATE_ON_START, poolMax: 2 });
  try {
    const counts = await privacyBackfill(db, { batchSize: Number(values.batch) });
    console.log(`sealed or re-sealed: ${counts.mandates} mandates, ${counts.payments} payments, ${counts.checkoutSessions} checkout sessions, ${counts.webhookDeliveries} webhook log rows`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
