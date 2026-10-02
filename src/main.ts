import { buildApp } from './api/app.js';
import { loadEnv } from './config/env.js';
import { buildContext } from './context.js';
import { createDb } from './db/client.js';
import { buildAdapters } from './psp/factory.js';

async function main() {
  const env = loadEnv();
  const { db, close } = await createDb(env.DATABASE_URL);

  const adapters = buildAdapters(env);
  console.log(`payment providers: ${adapters.map((a) => `${a.id} (${a.mode})`).join(', ')}`);

  const ctx = buildContext({ db, adapters, adminToken: env.ADMIN_TOKEN, secureCookies: env.NODE_ENV === 'production', customerTokenSecret: env.CUSTOMER_TOKEN_SECRET });
  const stops: Array<() => Promise<void>> = [];

  if (env.ROLE !== 'worker') {
    const app = buildApp(ctx, { logger: true });
    await app.listen({ host: env.HOST, port: env.PORT });
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
  console.error(e);
  process.exit(1);
});
