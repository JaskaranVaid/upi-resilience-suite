import { buildApp } from './api/app.js';
import { choosePort, loadDotEnv } from './config/dotenv.js';
import { loadEnv } from './config/env.js';
import { configureMdrEffectiveFrom, mdrStatus } from './config/rules.js';
import { buildContext } from './context.js';
import { createDb } from './db/client.js';
import { assertSchemaCurrent, schemaStatus } from './db/migrate.js';
import { DEFAULT_HEARTBEAT_FILE } from './ops/lifecycle.js';
import { jsonLogger } from './ops/log.js';
import { emitOpsMetrics } from './ops/metrics.js';
import { runJobs, startWorkerLoop } from './ops/worker-loop.js';
import { buildAdapters } from './psp/factory.js';
import { connectionAdapterFactory } from './psp/connections.js';
import { SecretBox } from './security/secrets.js';

const log = jsonLogger();

async function main() {
  loadDotEnv();
  // `npm run db:migrate` passes --migrate (same as ROLE=migrate, without setting a variable on Windows).
  const env = loadEnv(process.argv.includes('--migrate') ? { ...process.env, ROLE: 'migrate' } : process.env);
  configureMdrEffectiveFrom(env.MDR_EFFECTIVE_FROM ?? null);
  const mdr = mdrStatus(new Date());
  log.info(`UPI MDR: ${mdr.status}${mdr.effectiveFrom ? ` (from ${env.MDR_EFFECTIVE_FROM} IST)` : ' — set MDR_EFFECTIVE_FROM once NPCI confirms the start date'}`);
  if (env.ROLE === 'migrate') {
    // One-off deploy step: apply pending migrations (under an advisory lock on Postgres) and exit.
    const { db, close } = await createDb(env.DATABASE_URL, { migrate: true, poolMax: 1 });
    log.info('migrations applied', { ...(await schemaStatus(db)) });
    await close();
    return;
  }
  const { db, close } = await createDb(env.DATABASE_URL, { migrate: env.MIGRATE_ON_START, poolMax: env.DATABASE_POOL_MAX });
  if (!env.MIGRATE_ON_START) await assertSchemaCurrent(db);

  const adapters = buildAdapters(env);
  log.info(`shared payment providers (test-mode merchants): ${adapters.map((a) => `${a.id} (${a.mode})`).join(', ') || 'none'}`);
  const secrets = SecretBox.fromEnv(env.CREDENTIALS_KEYS, env.NODE_ENV);

  const ctx = buildContext({
    db,
    adapters,
    adminToken: env.ADMIN_TOKEN,
    secrets,
    encryptPersonalFields: env.ENCRYPT_PERSONAL_FIELDS === 'true',
    retention: { personalDataDays: env.PERSONAL_DATA_RETENTION_DAYS, webhookLogDays: env.WEBHOOK_LOG_RETENTION_DAYS },
    connectionAdapters: connectionAdapterFactory({ cashfreeTimeoutMs: env.CASHFREE_TIMEOUT_MS }), // system clock
    ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
    secureCookies: env.NODE_ENV === 'production',
    customerTokenSecret: env.CUSTOMER_TOKEN_SECRET,
    webhookTargets: env.WEBHOOK_TARGETS ?? (env.NODE_ENV === 'production' ? 'public-only' : 'any'),
    log,
  });
  const stops: Array<() => Promise<void>> = [];
  const serving = env.ROLE !== 'worker';

  if (serving) {
    const app = buildApp(ctx, { logger: true, trustProxy: env.TRUST_PROXY });
    // Configured port only (no silent switching for the real server); a busy port is a clear error.
    await app.listen({ host: env.HOST, port: await choosePort(env.PORT, { explicit: true, host: env.HOST }) });
    stops.push(() => app.close()); // waits for in-flight requests
  }

  if (env.ROLE !== 'api') {
    const worker = startWorkerLoop({
      tick: () =>
        runJobs(
          [
            { name: 'debits', run: async () => void (await ctx.worker.runOnce()) },
            { name: 'status-poller', run: async () => void (await ctx.poller.runOnce()) },
            { name: 'settlement-recon', run: async () => void (await ctx.reconciler.runDue()) }, // throttled internally (daily settlement reports)
            {
              name: 'double-debit-check', // pilot double-debit check, every 10 minutes
              run: async () => {
                const suspects = await ctx.duplicates.runDue();
                if (suspects > 0) log.warn('suspected double debits', { suspects });
              },
            },
            { name: 'webhooks', run: async () => void (await ctx.dispatcher.runOnce()) },
            {
              name: 'retention-purge', // daily
              run: async () => {
                const purged = await ctx.privacy.runDue();
                if (purged && Object.values(purged).some((n) => n > 0)) log.info('retention purge', { ...purged });
              },
            },
          ],
          log,
        ),
      heartbeatFile: env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_FILE,
      pollMs: env.WORKER_POLL_MS,
      log,
    });
    stops.push(() => worker.stop());
    log.info(`worker polling every ${env.WORKER_POLL_MS}ms`);

    if (env.OPS_METRICS_INTERVAL_MS > 0) {
      // Its own timer, so a long tick (slow PSPs) doesn't silence the heartbeat metric.
      let collecting = false;
      const timer = setInterval(() => {
        if (collecting) return;
        collecting = true;
        void emitOpsMetrics({ db, clock: ctx.clock, health: ctx.health }, log).finally(() => (collecting = false));
      }, env.OPS_METRICS_INTERVAL_MS);
      stops.unshift(async () => clearInterval(timer));
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    setTimeout(() => {
      log.error('graceful shutdown timed out; exiting', undefined, { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS).unref();
    ctx.lifecycle.beginDrain();
    // Let the load balancer see /readyz fail before we stop accepting connections.
    if (serving && env.SHUTDOWN_DRAIN_MS > 0) await new Promise((r) => setTimeout(r, env.SHUTDOWN_DRAIN_MS));
    for (const stop of stops) await stop();
    await close();
    log.info('stopped');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (e) => {
  log.error('unhandled promise rejection', e);
  process.exit(1);
});

main().catch((e) => {
  // Configuration problems get their message, not a stack trace.
  const configError = e instanceof Error && (e.name === 'PspConfigError' || e.name === 'ZodError' || /already in use|required in production|schema is behind/.test(e.message));
  if (configError) log.error(`Cannot start: ${e.message}`);
  else log.error('startup failed', e);
  process.exit(1);
});
