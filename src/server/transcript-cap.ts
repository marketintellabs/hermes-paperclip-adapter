/**
 * Transcript-entry cap.
 *
 * Motivation
 * ----------
 * `ctx.onLog(stream, chunk)` is the only path the adapter has to push
 * stdout/stderr into Paperclip's run transcript. For most heartbeats,
 * Hermes emits 10–50 chunks total: a few startup banner lines, a few
 * MCP tool-call traces, the assistant's final response. The Paperclip
 * UI handles that effortlessly.
 *
 * The pathological case is a runaway agent — wedged in a tool loop,
 * or chasing a long-form research thread with hundreds of small
 * status updates — that emits thousands of chunks. The transcript
 * blows past 1MB, the UI lags loading the run page, and dashboards
 * have to ferry around a transcript whose useful information is in
 * the first kilobyte and the last kilobyte.
 *
 * What this module does
 * ---------------------
 * Provides a small stateful counter that the wrapper around
 * `ctx.onLog` consults on every chunk:
 *
 *   - Below the cap: forward unchanged.
 *   - At the cap: emit one `[hermes] transcript truncated …` notice,
 *     then suppress further chunks.
 *   - `[hermes]`-prefixed adapter-emitted lines are ALWAYS forwarded,
 *     regardless of cap. These are structural diagnostics
 *     (banner, exit code, MCP telemetry summary, soft-timeout
 *     warning, auto-repair detector alerts) that an operator must
 *     not lose to a noisy LLM run.
 *
 * The cap is opt-in. With `max <= 0` the helper is a passthrough.
 *
 * Why count chunks (not bytes)
 * ----------------------------
 * `runChildProcess` already coalesces stdout into reasonable-sized
 * chunks (typically 1–8KiB). A chunk-count cap is therefore a coarse
 * proxy for byte size — easy to reason about (~"keep the first ~200
 * lines worth of streamed output"), trivial to test, and matches the
 * granularity Paperclip stores. A byte-cap would require tracking
 * partial chunks and re-encoding multi-byte sequences correctly; not
 * worth the complexity for an observability ergonomic.
 */

export interface TranscriptCap {
  /**
   * Decide whether the given chunk should be forwarded. Returns the
   * effective chunk to forward (possibly transformed; for the
   * threshold tick we also append a one-time truncation notice) or
   * `null` to drop entirely.
   */
  shouldForward(stream: "stdout" | "stderr", chunk: string): string | null;
  /** How many chunks have been observed so far (forwarded or not). */
  observed(): number;
  /** How many chunks have been suppressed past the cap. */
  suppressed(): number;
  /** Whether the cap was ever hit during this run. */
  truncated(): boolean;
  /** The configured cap (0 means unlimited / no cap). */
  cap(): number;
}

interface CreateOptions {
  /**
   * Maximum number of chunks to forward to ctx.onLog. `<= 0` disables
   * the cap entirely (passthrough mode).
   */
  max: number;
}

const ADAPTER_PREFIX = "[hermes]";

/** Adapter-emitted diagnostic lines bypass the cap. */
function isAdapterDiagnostic(chunk: string): boolean {
  // Trim leading whitespace because the adapter occasionally emits
  // lines with embedded leading spaces from buildPaperclipEnv() etc.
  const trimmed = chunk.trimStart();
  return trimmed.startsWith(ADAPTER_PREFIX);
}

/**
 * Build a stateful cap. Safe to call once per `execute()` invocation.
 */
export function createTranscriptCap(opts: CreateOptions): TranscriptCap {
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 0;
  let observed = 0;
  let suppressed = 0;
  let noticeEmitted = false;

  return {
    shouldForward(_stream, chunk) {
      observed += 1;

      // Cap disabled: always forward.
      if (max === 0) return chunk;

      // Adapter diagnostics are always forwarded so the structural
      // framing of a run (banner / exit code / telemetry) is never
      // lost to truncation.
      if (isAdapterDiagnostic(chunk)) return chunk;

      // Within budget: forward as-is.
      if (observed <= max) return chunk;

      // First chunk past the cap: forward a single notice line
      // instead of the chunk content. Subsequent chunks are dropped
      // entirely.
      if (!noticeEmitted) {
        noticeEmitted = true;
        suppressed += 1;
        return (
          `[hermes] transcript truncated: cap=${max} reached, further LLM ` +
          `output suppressed (adapter diagnostics still forwarded). ` +
          `Adjust adapterConfig.maxTranscriptEntries if you need more.\n`
        );
      }

      suppressed += 1;
      return null;
    },
    observed: () => observed,
    suppressed: () => suppressed,
    truncated: () => noticeEmitted,
    cap: () => max,
  };
}
