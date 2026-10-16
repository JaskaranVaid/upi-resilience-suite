import { pathToFileURL } from 'node:url';
import { DEFAULT_HEARTBEAT_FILE, heartbeatAgeMs } from './lifecycle.js';

export interface HealthCheckOptions {
  role: 'api' | 'worker' | 'all' | 'migrate';
  port: number;
  heartbeatFile: string;
  /** A worker whose last completed tick is older than this is considered stuck. */
  maxHeartbeatAgeMs: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}

/**
 * Container health check (Docker HEALTHCHECK / ECS): the api answers /healthz on localhost; the
 * worker has no HTTP server, so it proves progress through its heartbeat file.
 */
export async function checkHealth(o: HealthCheckOptions): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (o.role === 'api' || o.role === 'all') {
    try {
      const res = await (o.fetchImpl ?? fetch)(`http://127.0.0.1:${o.port}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.status !== 200) return { ok: false, reason: `api: /healthz answered ${res.status}` };
    } catch (e) {
      return { ok: false, reason: `api: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (o.role === 'worker' || o.role === 'all') {
    const age = await heartbeatAgeMs(o.heartbeatFile, o.now ?? new Date());
    if (age === null) return { ok: false, reason: 'worker: no heartbeat yet' };
    if (age > o.maxHeartbeatAgeMs) return { ok: false, reason: `worker: last tick ${Math.round(age / 1000)}s ago` };
  }
  return { ok: true };
}

// `node dist/ops/healthcheck.js` — exit 0 when healthy. Reads the same variables as the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const role = (env.ROLE ?? 'all') as HealthCheckOptions['role'];
  checkHealth({
    role,
    port: Number(env.PORT ?? 3000),
    heartbeatFile: env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_FILE,
    maxHeartbeatAgeMs: Number(env.WORKER_STALL_MS ?? 600_000),
  }).then((r) => {
    if (!r.ok) console.error(`unhealthy: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  });
}
