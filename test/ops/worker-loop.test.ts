import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { heartbeatAgeMs } from '../../src/ops/lifecycle.js';
import { jsonLogger } from '../../src/ops/log.js';
import { runJobs, startWorkerLoop } from '../../src/ops/worker-loop.js';

const file = async () => join(await mkdtemp(join(tmpdir(), 'mf-loop-')), 'hb');

describe('worker loop', () => {
  it('writes a heartbeat as soon as it starts, so a long first tick (a backlog) is not mistaken for a dead worker', async () => {
    const hb = await file();
    let release!: () => void;
    const firstTick = new Promise<void>((r) => (release = r));
    const loop = startWorkerLoop({ tick: () => firstTick, heartbeatFile: hb, pollMs: 10, log: jsonLogger(() => {}) });
    await new Promise((r) => setTimeout(r, 50));
    expect(await heartbeatAgeMs(hb)).not.toBeNull();
    release();
    await loop.stop();
  });

  it('keeps running after a failed tick and logs it', async () => {
    const lines: string[] = [];
    let ticks = 0;
    const loop = startWorkerLoop({
      tick: async () => {
        ticks++;
        if (ticks === 1) throw new Error('database blip');
      },
      heartbeatFile: await file(),
      pollMs: 5,
      log: jsonLogger((l) => lines.push(l)),
    });
    while (ticks < 3) await new Promise((r) => setTimeout(r, 5));
    await loop.stop();
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', msg: 'worker tick failed', err: { message: 'database blip' } });
  });

  it("runs every job of a tick even when one throws, and logs which one failed", async () => {
    const lines: string[] = [];
    const ran: string[] = [];
    await runJobs(
      [
        { name: 'debits', run: async () => void ran.push('debits') },
        { name: 'duplicates', run: async () => { throw new Error('scan query failed'); } },
        { name: 'webhooks', run: async () => void ran.push('webhooks') },
      ],
      jsonLogger((l) => lines.push(l)),
    );
    expect(ran).toEqual(['debits', 'webhooks']);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ level: 'error', msg: 'worker job failed', job: 'duplicates', err: expect.objectContaining({ message: 'scan query failed' }) }),
    ]);
  });

  it('stops without waiting out the poll interval, after the tick in progress finishes', async () => {
    let ticks = 0;
    const loop = startWorkerLoop({ tick: async () => void ticks++, heartbeatFile: await file(), pollMs: 60_000, log: jsonLogger(() => {}) });
    while (ticks < 1) await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    await loop.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ticks).toBe(1);
  });
});
