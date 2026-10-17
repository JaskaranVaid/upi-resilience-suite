import { writeHeartbeat } from './lifecycle.js';
import type { Logger } from './log.js';

export interface WorkerLoop {
  /** Finish the tick in progress (claimed debits are never abandoned mid-call), skip the idle wait, stop. */
  stop(): Promise<void>;
}

/** One step of the worker's tick: due debits, the status poller, webhook delivery, … */
export interface WorkerJob {
  name: string;
  run: () => Promise<void>;
}

/**
 * Run the jobs in order, each on its own: one that throws is logged and the rest still run, so a
 * fault in one (say the duplicate scan) never holds up another (say webhook delivery).
 */
export async function runJobs(jobs: WorkerJob[], log: Logger): Promise<void> {
  for (const job of jobs) {
    try {
      await job.run();
    } catch (e) {
      log.error('worker job failed', e, { job: job.name });
    }
  }
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
