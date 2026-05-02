/**
 * Run-liveness tracking for heartbeat runs (0.8.20-mil.0+).
 *
 * Adopts the structured-liveness telemetry shape introduced upstream in
 * Paperclip v2026.428.0 (#4083). The heartbeat scheduler upstream tracks
 * `livenessState` (`active` / `stalled` / `dead`), `lastProgressAt`, and
 * `nextActionHint` per run; this module emits the per-run-side companion
 * fields so dashboards / postmortems / a future Staff Engineer agent can
 * distinguish:
 *
 *   - "agent ran cleanly" (`active`, no hints)
 *   - "agent finished but brushed its deadline" (`stalled`, hints to
 *      raise `timeoutSec`)
 *   - "agent never came back" (`dead`, hints to investigate the reason)
 *
 * The fields land on `result_json` alongside the existing 0.8.x telemetry
 * (`adapterVersion`, `retries`, `transcriptCap`, `toolCallCount`, etc.):
 *
 *   result_json.livenessState     — terminal state for the run
 *   result_json.progressBeats[]   — chronological structured events
 *                                    (run_start, soft_timeout_reached,
 *                                    retry_triggered, run_end, …)
 *   result_json.nextActionHints[] — operator-actionable suggestions
 *                                    derived from the run's observed
 *                                    behaviour (deduped)
 *
 * Pure observation. Does NOT modify run outcome, prompt templates, MCP
 * tool exposure, or Hermes args. Wire-format additive — older Paperclip
 * versions persist the new fields in `result_json` JSONB without acting
 * on them, so this is safe to ship ahead of any consumer-side code.
 *
 * The optional `livenessHeartbeatSec` config schedules a periodic
 * `heartbeat_tick` beat while the child is running — useful for agents
 * that occasionally spend 5+ minutes in a single tool call (deep web
 * scrapes, large code generation). Default off (`0`); when enabled the
 * tick interval is clamped to a sensible floor so we don't spam beats
 * for runs that finish in seconds.
 *
 * Future direction: when upstream's `POST /api/runs/:id/liveness` endpoint
 * shape stabilises out of BETA, this module will gain an HTTP emitter so
 * the upstream watchdog gets in-band liveness signals instead of having
 * to infer from output silence. That work is gated on observing the
 * endpoint contract in production; today's tracker is purely local.
 */

/**
 * Terminal liveness verdict for a heartbeat run.
 *
 * - `active`   — run reached completion without crossing the soft-timeout
 *                threshold and without any subprocess-level crash. Most
 *                runs land here.
 * - `stalled`  — run reached the configured soft-timeout threshold (default
 *                80% of `timeoutSec`) but did not hard-time-out. The agent
 *                is consistently brushing its deadline — operator should
 *                consider raising `timeoutSec` before a future run actually
 *                trips the hard limit.
 * - `dead`     — hard timeout fired, the paperclip-mcp subprocess crashed
 *                mid-run, or some other non-recoverable termination event
 *                occurred. `nextActionHints[]` carries the specific reason.
 *
 * Once a tracker reaches `dead`, subsequent `markStalled()` calls are
 * ignored — `dead` is a sticky state because anything that took us there
 * is more interesting than later soft signals.
 */
export type LivenessState = "active" | "stalled" | "dead";

/**
 * A single chronological event observed during the run. The `kind` field
 * is intentionally an unconstrained string so 0.8.x can keep adding new
 * beat types (auto-repair detection, bypass attempt, etc.) without a
 * breaking change to the wire format. Known kinds emitted by the adapter
 * today:
 *
 *   run_start            — emitted once when the tracker is constructed
 *   heartbeat_tick       — periodic tick when livenessHeartbeatSec is set
 *   soft_timeout_reached — soft-timeout warning fired (run still going)
 *   retry_triggered      — transient-failure retry began (with reason)
 *   run_end              — emitted once after the runChildProcess loop
 *                          terminates, just before result_json is built
 *
 * `detail` is an opaque human-readable string carrying useful context
 * (e.g. "elapsed=42s" on a heartbeat tick, the retry classifier reason
 * on a retry beat). Always optional so callers can skip it when there
 * is nothing additional to say.
 */
export interface ProgressBeat {
  kind: string;
  ts: string;
  detail?: string;
}

/**
 * Final summary returned by `LivenessTracker.summary()`. Exact shape
 * landed on `result_json` (see top-of-file docstring).
 *
 * The arrays are fresh copies on every call to `summary()`, so consumers
 * may freely mutate them without affecting tracker state. `nextActionHints`
 * is exposed as an array (not a Set) because JSON serialization is part
 * of the contract — the tracker dedupes internally.
 */
export interface LivenessSummary {
  livenessState: LivenessState;
  progressBeats: ProgressBeat[];
  nextActionHints: string[];
}

/**
 * Minimum sensible heartbeat interval. A tick every <5s would generate
 * dozens of beats per minute on long runs and dilute the higher-signal
 * events without buying meaningful resolution.
 */
const MIN_HEARTBEAT_SEC = 5;

export class LivenessTracker {
  private state: LivenessState = "active";
  private readonly beats: ProgressBeat[] = [];
  private readonly hints: Set<string> = new Set();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly startedAtMs: number;

  /**
   * `now` is injectable so tests can pin timestamps deterministically.
   * Production callers leave it unset and get `new Date()` at every
   * beat, which is what we want.
   */
  constructor(private readonly now: () => Date = () => new Date()) {
    this.startedAtMs = this.now().getTime();
  }

  /**
   * Append a progress beat. Always succeeds — the tracker never throws
   * on observation calls so callers don't need to wrap in try/catch on
   * the hot path. `detail` is omitted from the persisted record when
   * undefined so dashboards can distinguish "no detail" from
   * "detail was the literal string undefined".
   */
  recordBeat(kind: string, detail?: string): void {
    const beat: ProgressBeat = {
      kind,
      ts: this.now().toISOString(),
    };
    if (detail !== undefined) {
      beat.detail = detail;
    }
    this.beats.push(beat);
  }

  /**
   * Add a hint. Hints are deduped (a `Set` under the hood) because the
   * same condition can fire multiple times during a run — e.g. retry
   * triggers across multiple attempts all suggesting the same upstream
   * investigation. Surfacing the hint once is enough for the operator.
   */
  recordHint(hint: string): void {
    this.hints.add(hint);
  }

  /**
   * Promote state to `stalled` if currently `active`. No-op when the
   * tracker has already reached `stalled` or `dead` — `dead` is
   * sticky and `stalled` is idempotent.
   */
  markStalled(): void {
    if (this.state === "active") {
      this.state = "stalled";
    }
  }

  /**
   * Promote state to `dead` and add `reason` as a hint so the operator
   * sees why the run was classified as dead even if they only look at
   * `nextActionHints[]`. Always wins over `active` and `stalled`.
   */
  markDead(reason: string): void {
    this.state = "dead";
    this.hints.add(reason);
  }

  /**
   * Begin emitting periodic `heartbeat_tick` beats. Clamped to a
   * `MIN_HEARTBEAT_SEC` floor; intervals at or below zero disable the
   * heartbeat entirely (no-op). Idempotent: a second call without
   * `stopHeartbeat()` between is a no-op so callers don't have to
   * track timer ownership.
   *
   * The interval is unref()d so it never holds the event loop open
   * past `stopHeartbeat()` — important because execute.ts runs this
   * inside a long-lived adapter process where a leaked interval
   * would survive run completion.
   */
  startHeartbeat(intervalSec: number): void {
    if (this.heartbeatTimer) return;
    if (typeof intervalSec !== "number" || intervalSec <= 0) return;
    const clamped = Math.max(intervalSec, MIN_HEARTBEAT_SEC);
    this.heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.floor(
        (this.now().getTime() - this.startedAtMs) / 1000,
      );
      this.recordBeat("heartbeat_tick", `elapsed=${elapsedSec}s`);
    }, clamped * 1000);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Stop the heartbeat timer if running. Safe to call multiple times
   * and safe to call when no heartbeat was ever started — paired with
   * `startHeartbeat()` in a `try/finally` in execute.ts so a synchronous
   * throw in the run path can't leak the interval.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Snapshot the tracker. Returned arrays are fresh copies — callers
   * may mutate them freely. `nextActionHints` is sorted to give a
   * stable diff-friendly order for `result_json` payloads (Paperclip
   * persists the JSONB verbatim and dashboards do string-equal compares
   * across runs to detect drift).
   */
  summary(): LivenessSummary {
    return {
      livenessState: this.state,
      progressBeats: this.beats.map((b) => ({ ...b })),
      nextActionHints: [...this.hints].sort(),
    };
  }
}
