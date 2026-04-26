/**
 * Soft-timeout warning helper.
 *
 * The hard-timeout (`timeoutSec` in adapterConfig) is the only safety net
 * against a Hermes run hanging forever (infinite tool loop, stuck browser
 * session, runaway delegate chain, etc). When the hard timeout fires the
 * adapter SIGTERMs the child and the run is reported as `timedOut: true`.
 *
 * Operationally this is a binary signal — agents that consistently brush
 * up against their hard timeout are invisible until the day they finally
 * trip it. A "soft" warning at a configurable fraction of the hard timeout
 * (default 80%) gives the operator a chance to right-size the timeout
 * before it becomes a failure.
 *
 * The warning is purely observational — it logs a single `[hermes] WARN:`
 * line to the run transcript and does NOT modify run behaviour. Disable
 * via `adapterConfig.softTimeoutWarn = false`. Threshold is tunable via
 * `adapterConfig.softTimeoutThreshold` (0.0 < t < 1.0).
 */

export interface SoftTimeoutPlan {
  /** Whether the warning should fire at all. */
  enabled: boolean;
  /** Milliseconds to wait before firing the warning. */
  delayMs: number;
  /** Resolved threshold (e.g. 0.8 = 80%). */
  threshold: number;
}

const DEFAULT_THRESHOLD = 0.8;
const MIN_DELAY_MS = 5000; // No point warning at <5s — too noisy

interface PlanOptions {
  /** Hard timeout in seconds (timeoutSec from adapterConfig). */
  timeoutSec: number;
  /** Optional override for the warning threshold (0.0 < t < 1.0). */
  threshold?: number;
  /** Operator opt-out (default: enabled). */
  enabled?: boolean;
}

/**
 * Compute when (if at all) to fire the soft-timeout warning. Returns
 * `enabled: false` when the warning should be skipped entirely (timeout
 * too short, threshold out of range, operator opted out, etc.).
 */
export function planSoftTimeout(opts: PlanOptions): SoftTimeoutPlan {
  if (opts.enabled === false) {
    return { enabled: false, delayMs: 0, threshold: 0 };
  }

  const threshold =
    typeof opts.threshold === "number" && opts.threshold > 0 && opts.threshold < 1
      ? opts.threshold
      : DEFAULT_THRESHOLD;

  if (typeof opts.timeoutSec !== "number" || opts.timeoutSec <= 0) {
    return { enabled: false, delayMs: 0, threshold };
  }

  const delayMs = Math.floor(opts.timeoutSec * 1000 * threshold);
  if (delayMs < MIN_DELAY_MS) {
    return { enabled: false, delayMs, threshold };
  }

  return { enabled: true, delayMs, threshold };
}

/**
 * Format the warning message body. Surfaces the threshold, the elapsed
 * time, and the configured hard timeout so an operator can immediately
 * see how close the agent is to its deadline.
 */
export function formatSoftTimeoutWarning(plan: SoftTimeoutPlan, timeoutSec: number): string {
  const elapsedSec = Math.floor(plan.delayMs / 1000);
  const pct = Math.round(plan.threshold * 100);
  return (
    `[hermes] WARN: soft-timeout reached at ${elapsedSec}s (${pct}% of ${timeoutSec}s hard limit). ` +
    `Run still in progress; consider raising adapterConfig.timeoutSec if this becomes routine.\n`
  );
}
