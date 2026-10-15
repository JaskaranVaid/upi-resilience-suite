import { buildApp } from './api/app.js';
import { choosePort, loadDotEnv } from './config/dotenv.js';
import { loadEnv } from './config/env.js';
import { configureMdrEffectiveFrom, mdrStatus } from './config/rules.js';
import { buildContext } from './context.js';
import { createDb } from './db/client.js';
import { buildAdapters } from './psp/factory.js';
import { connectionAdapterFactory } from './psp/connections.js';
import { SecretBox } from './security/secrets.js';

async function main() {
  loadDotEnv();
  const env = loadEnv();
  configureMdrEffectiveFrom(env.MDR_EFFECTIVE_FROM ?? null);
  const mdr = mdrStatus(new Date());
  console.log(`UPI MDR: ${mdr.status}${mdr.effectiveFrom ? ` (from ${env.MDR_EFFECTIVE_FROM} IST)` : ' — set MDR_EFFECTIVE_FROM once NPCI confirms the start date'}`);
  const { db, close } = await createDb(env.DATABASE_URL);

  const adapters = buildAdapters(env);
  console.log(`shared payment providers (test-mode merchants): ${adapters.map((a) => `${a.id} (${a.mode})`).join(', ') || 'none'}`);
  const secrets = SecretBox.fromEnv(env.CREDENTIALS_KEYS, env.NODE_ENV);

  const ctx = buildContext({
    db,
    adapters,
    adminToken: env.ADMIN_TOKEN,
    secrets,
    connectionAdapters: connectionAdapterFactory({ cashfreeTimeoutMs: env.CASHFREE_TIMEOUT_MS }),
    ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
    secureCookies: env.NODE_ENV === 'production',
    customerTokenSecret: env.CUSTOMER_TOKEN_SECRET,
    webhookTargets: env.WEBHOOK_TARGETS ?? (env.NODE_ENV === 'production' ? 'public-only' : 'any'),
  });
  const stops: Array<() => Promise<void>> = [];

  if (env.ROLE !== 'worker') {
    const app = buildApp(ctx, { logger: true, trustProxy: env.TRUST_PROXY });
    // Configured port only (no silent switching for the real server); a busy port is a clear error.
    await app.listen({ host: env.HOST, port: await choosePort(env.PORT, { explicit: true, host: env.HOST }) });
    stops.push(() => app.close());
  }

  if (env.ROLE !== 'api') {
    let running = true;
    const loop = (async () => {
      while (running) {
        try {
          await ctx.worker.runOnce();
          await ctx.poller.runOnce();
          await ctx.dispatcher.runOnce();
        } catch (e) {
          console.error('worker tick failed', e);
        }
        await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
      }
    })();
    stops.push(async () => {
      running = false;
      await loop;
    });
    console.log(`worker polling every ${env.WORKER_POLL_MS}ms`);
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    for (const stop of stops) await stop();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  // Configuration problems get their message, not a stack trace.
  const configError = e instanceof Error && (e.name === 'PspConfigError' || e.name === 'ZodError' || /already in use|required in production/.test(e.message));
  console.error(configError ? `Cannot start: ${e.message}` : e);
  process.exit(1);
});
