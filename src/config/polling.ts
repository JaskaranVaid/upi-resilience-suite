/**
 * Payment verification (status polling) budget. Every timing the poller and the status
 * wording use comes from here — override per deployment rather than editing services.
 */
export interface PollingConfig {
  /** First checks, as offsets from when verification started. */
  initialOffsetsMs: number[];
  /** Interval after the initial offsets, while elapsed < fastPhaseUntilMs. */
  fastIntervalMs: number;
  fastPhaseUntilMs: number;
  /** Interval after the fast phase. */
  slowIntervalMs: number;
  /** After this long without a definitive answer → NEEDS_MANUAL_INVESTIGATION. */
  maxDurationMs: number;
  /** Optional hard cap on checks; null = bounded by duration only. */
  maxChecks: number | null;
  /** How long a claimed check is exclusive to one worker/request. */
  leaseMs: number;
  /** A pending payment older than this is described as "verification in progress". */
  verifyingAfterMs: number;
  /** Minimum gap between manual "Recheck now" requests for the same payment. */
  manualRecheckCooldownMs: number;
  batchSize: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const DEFAULT_POLLING: PollingConfig = {
  initialOffsetsMs: [5 * SECOND, 15 * SECOND, 30 * SECOND, 45 * SECOND],
  fastIntervalMs: 1 * MINUTE,
  fastPhaseUntilMs: 15 * MINUTE,
  slowIntervalMs: 15 * MINUTE,
  maxDurationMs: 48 * HOUR,
  maxChecks: null,
  leaseMs: 30 * SECOND,
  verifyingAfterMs: 45 * SECOND,
  manualRecheckCooldownMs: 10 * SECOND,
  batchSize: 50,
};
