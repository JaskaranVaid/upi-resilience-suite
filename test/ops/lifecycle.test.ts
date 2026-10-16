import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { checkHealth } from '../../src/ops/healthcheck.js';
import { heartbeatAgeMs, writeHeartbeat } from '../../src/ops/lifecycle.js';
import { jsonLogger } from '../../src/ops/log.js';
import { freshDb, ist } from '../helpers/fixtures.js';

describe('health probes and draining', () => {
  let app: FastifyInstance;
  let ctx: AppContext;

  beforeEach(async () => {
    const { db } = await freshDb();
    ctx = buildContext({ db, adapters: [], adminToken: 'test-admin-token', clock: new FakeClock(ist('2026-10-15T10:30:00')) });
    app = buildApp(ctx);
  });

  // The database is shared across tests in this file: never leave a stub behind.
  afterEach(() => vi.restoreAllMocks());

  it('answers liveness without touching the database', async () => {
    const execute = vi.spyOn(ctx.db, 'execute');
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('is ready while the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('is not ready once draining, so the load balancer stops sending traffic before shutdown', async () => {
    ctx.lifecycle.beginDrain();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'draining' });
    // Liveness is unaffected: the process is healthy, just leaving.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('logs why it is not ready, although probe requests themselves are not logged', async () => {
    const logged = buildApp(ctx, { logger: true });
    const warn = vi.spyOn(logged.log, 'warn').mockImplementation(() => {});
    vi.spyOn(ctx.db, 'execute').mockRejectedValue(new Error('connection refused'));
    expect((await logged.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'readiness: database unreachable');
  });

  it('is not ready when the database is unreachable', async () => {
    vi.spyOn(ctx.db, 'execute').mockRejectedValue(new Error('connection refused'));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
  });
});

describe('worker heartbeat', () => {
  it('reports the age of the last heartbeat, or null when there is none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-hb-'));
    const file = join(dir, 'worker.heartbeat');
    expect(await heartbeatAgeMs(file, new Date())).toBeNull();
    await writeHeartbeat(file, new Date('2026-10-15T05:00:00Z'));
    expect(await heartbeatAgeMs(file, new Date('2026-10-15T05:00:42Z'))).toBe(42_000);
  });

  it('treats an unreadable heartbeat as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-hb-'));
    const file = join(dir, 'worker.heartbeat');
    await writeFile(file, 'not a date');
    expect(await heartbeatAgeMs(file, new Date())).toBeNull();
  });
});

describe('container health check', () => {
  const now = new Date('2026-10-15T05:00:00Z');
  const ok = (async () => new Response('{"status":"ok"}', { status: 200 })) as typeof fetch;
  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  async function heartbeat(ageMs: number | null) {
    const file = join(await mkdtemp(join(tmpdir(), 'mf-hc-')), 'hb');
    if (ageMs !== null) await writeHeartbeat(file, new Date(now.getTime() - ageMs));
    return file;
  }

  it('checks /healthz for the api role', async () => {
    const base = { role: 'api' as const, port: 3000, heartbeatFile: await heartbeat(null), maxHeartbeatAgeMs: 60_000, now };
    expect(await checkHealth({ ...base, fetchImpl: ok })).toEqual({ ok: true });
    expect(await checkHealth({ ...base, fetchImpl: down })).toEqual({ ok: false, reason: 'api: ECONNREFUSED' });
  });

  it('checks the heartbeat for the worker role and never calls HTTP', async () => {
    const base = { role: 'worker' as const, port: 3000, maxHeartbeatAgeMs: 60_000, now, fetchImpl: down };
    expect(await checkHealth({ ...base, heartbeatFile: await heartbeat(10_000) })).toEqual({ ok: true });
    expect(await checkHealth({ ...base, heartbeatFile: await heartbeat(90_000) })).toEqual({ ok: false, reason: 'worker: last tick 90s ago' });
    expect(await checkHealth({ ...base, heartbeatFile: await heartbeat(null) })).toEqual({ ok: false, reason: 'worker: no heartbeat yet' });
  });

  it('needs both for the all role', async () => {
    const base = { role: 'all' as const, port: 3000, maxHeartbeatAgeMs: 60_000, now };
    expect(await checkHealth({ ...base, heartbeatFile: await heartbeat(1_000), fetchImpl: ok })).toEqual({ ok: true });
    expect((await checkHealth({ ...base, heartbeatFile: await heartbeat(1_000), fetchImpl: down })).ok).toBe(false);
    expect((await checkHealth({ ...base, heartbeatFile: await heartbeat(null), fetchImpl: ok })).ok).toBe(false);
  });
});

describe('JSON logger', () => {
  it('writes one JSON object per line with level, time, message and fields', () => {
    const lines: string[] = [];
    const log = jsonLogger((l) => lines.push(l), () => new Date('2026-10-15T05:00:00Z'));
    log.info('ops.metrics', { pollerBacklog: 3 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ level: 'info', time: '2026-10-15T05:00:00.000Z', msg: 'ops.metrics', pollerBacklog: 3 });
  });

  it('keeps an error and its stack on the same line', () => {
    const lines: string[] = [];
    const log = jsonLogger((l) => lines.push(l));
    log.error('worker tick failed', new Error('boom\nsecond line'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const entry = JSON.parse(lines[0]!);
    expect(entry.level).toBe('error');
    expect(entry.err.message).toBe('boom\nsecond line');
    expect(entry.err.stack).toContain('Error: boom');
  });

  it('logs a non-Error thrown value as a string', () => {
    const lines: string[] = [];
    jsonLogger((l) => lines.push(l)).error('odd failure', 'just a string');
    expect(JSON.parse(lines[0]!).err).toEqual({ message: 'just a string' });
  });
});
