import type { PollingConfig } from '../config/polling.js';

/** All check times, as offsets from verification start, within the configured budget. */
export function checkTimesMs(cfg: PollingConfig): number[] {
  const times = cfg.initialOffsetsMs.filter((t) => t <= cfg.maxDurationMs);
  let prev = times.at(-1) ?? 0;
  for (;;) {
    prev += prev < cfg.fastPhaseUntilMs ? cfg.fastIntervalMs : cfg.slowIntervalMs;
    if (prev > cfg.maxDurationMs) break;
    times.push(prev);
  }
  return cfg.maxChecks === null ? times : times.slice(0, cfg.maxChecks);
}

/**
 * The next scheduled check strictly after `now`, or null once the budget is spent.
 * Time-based rather than count-based, so manual rechecks don't shift the schedule.
 */
export function nextCheckAt(startedAt: Date, now: Date, cfg: PollingConfig): Date | null {
  const elapsed = now.getTime() - startedAt.getTime();
  const next = checkTimesMs(cfg).find((t) => t > elapsed);
  return next === undefined ? null : new Date(startedAt.getTime() + next);
}
