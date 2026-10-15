/**
 * Verify a database without changing it: `npm run db:verify` locally, or
 * `node dist/ops/verify-cli.js` in a container (the restore drill runs it as an ECS task with
 * VERIFY_DATABASE_HOST pointing at the restored instance). Exit 0 when it passes.
 */
import { loadDotEnv } from '../config/dotenv.js';
import { createDb } from '../db/client.js';
import { jsonLogger } from './log.js';
import { verifyDatabase, withHost } from './verify.js';

const log = jsonLogger();

async function run(): Promise<boolean> {
  loadDotEnv();
  const configured = process.env.DATABASE_URL ?? 'pglite://.data/pg';
  const host = process.env.VERIFY_DATABASE_HOST;
  const url = host ? withHost(configured, host) : configured;
  const { db, close } = await createDb(url, { migrate: false, poolMax: 2 });
  try {
    const report = await verifyDatabase(db);
    log.info('db.verify', { ...(host ? { host } : {}), ...report });
    return report.ok;
  } finally {
    await close();
  }
}

run().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    log.error('db.verify failed', e);
    process.exit(1);
  },
);
