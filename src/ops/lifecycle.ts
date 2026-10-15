import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Process state shared with the HTTP layer: once draining, /readyz fails so traffic moves away. */
export class Lifecycle {
  private drainingSince: Date | null = null;

  get draining(): boolean {
    return this.drainingSince !== null;
  }

  beginDrain(now = new Date()): void {
    this.drainingSince ??= now;
  }
}

export const DEFAULT_HEARTBEAT_FILE = join(tmpdir(), 'merchantflo-worker.heartbeat');

/** The worker loop records each completed tick here; the container health check reads it. */
export async function writeHeartbeat(file: string, now = new Date()): Promise<void> {
  await writeFile(file, now.toISOString());
}

/** Milliseconds since the last heartbeat, or null if there is none (or it can't be read). */
export async function heartbeatAgeMs(file: string, now = new Date()): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const at = Date.parse(text.trim());
  return Number.isNaN(at) ? null : now.getTime() - at;
}
