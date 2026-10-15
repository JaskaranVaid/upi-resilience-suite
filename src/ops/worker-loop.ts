import { writeHeartbeat } from './lifecycle.js';
import type { Logger } from './log.js';

export interface WorkerLoop {
  /** Finish the tick in progress (claimed debits are never abandoned mid-call), skip the idle wait, stop. */
  stop(): Promise<void>;
}

/**
 * Run `tick` repeatedly, `pollMs` apart. The heartbeat file is written when the loop starts and
 * after every tick, so the container health check sees a live worker even while a long first
 * tick works through a backlog (it only fails once a tick runs past WORKER_STALL_MS).
 */
export function startWorkerLoop(o: { tick: () => Promise<void>; heartbeatFile: string; pollMs: number; log: Logger }): WorkerLoop {
  let running = true;
  let wake: () => void = () => {};
  let timer: NodeJS.Timeout | undefined;
  const beat = () => writeHeartbeat(o.heartbeatFile).catch((e) => o.log.warn('heartbeat write failed', { file: o.heartbeatFile, error: String(e) }));

  const loop = (async () => {
    await beat();
    while (running) {
      try {
        await o.tick();
      } catch (e) {
        o.log.error('worker tick failed', e);
      }
      await beat();
      if (running) await new Promise<void>((r) => ((wake = r), (timer = setTimeout(r, o.pollMs))));
    }
  })();

  return {
    async stop() {
      running = false;
      clearTimeout(timer);
      wake();
      await loop;
    },
  };
}
