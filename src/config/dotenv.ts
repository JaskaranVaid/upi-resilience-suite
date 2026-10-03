import { createServer } from 'node:net';

/**
 * Load `.env` from the working directory if present (Node's built-in loader). Variables already
 * set in the shell take precedence, so this works the same from PowerShell, cmd or bash.
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, host);
  });
}

/**
 * The port to listen on: the requested one if free; if it was only a default, the next free one.
 * An explicitly requested port that is busy is an error with a clear message (not a stack trace).
 */
export async function choosePort(requested: number, opts: { explicit: boolean; host: string; tries?: number }): Promise<number> {
  if (await isFree(requested, opts.host)) return requested;
  if (opts.explicit) {
    throw new Error(`Port ${requested} is already in use (is another copy running?). Stop it, or set PORT to a different number.`);
  }
  for (let p = requested + 1; p <= requested + (opts.tries ?? 20); p++) {
    if (await isFree(p, opts.host)) return p;
  }
  throw new Error(`Ports ${requested}–${requested + (opts.tries ?? 20)} are all in use. Set PORT to a free port.`);
}
