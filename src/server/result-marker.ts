/**
 * RESULT marker parser for adapter-owned status transitions.
 *
 * The `mil-heartbeat-v2` prompt template (and future templates that opt
 * into adapter-owned status) instructs the LLM to end its final
 * assistant message with a line like:
 *
 *     RESULT: done
 *
 * or, for escalations:
 *
 *     RESULT: blocked
 *     reason: <one-sentence reason>
 *
 *     RESULT: cancelled
 *     reason: <one-sentence reason>
 *
 * The adapter parses this marker AFTER the Hermes run completes and uses
 * it to decide which terminal status to PATCH the issue to. This removes
 * the need for the LLM to emit its own `curl PATCH .../status=...` call
 * (the root cause of the reconciler-race bug fixed in 0.3.2-mil.0).
 *
 * Design notes:
 *   - We scan for the LAST occurrence of the marker in the message so a
 *     stray `RESULT:` in code blocks or quoted text earlier doesn't win.
 *   - The marker must be on its own line — matching is anchored with
 *     `^` / `$` under the `m` flag.
 *   - Outcome strings are case-insensitive; we lowercase before
 *     comparing.
 *   - When no marker is present, callers should default to `done` on a
 *     clean exit (preserves pre-v2 behaviour) and log a prompt-following
 *     warning.
 */

export type RunOutcome = "done" | "blocked" | "cancelled";

export interface ResultMarker {
  outcome: RunOutcome;
  reason?: string;
}

const LEADING_PREFIX = "[ \\t>`*+\\-]*";
const MARKER_LINE_REGEX = new RegExp(
  `^${LEADING_PREFIX}RESULT:\\s*(done|blocked|cancelled)\\s*$`,
  "gim",
);
const REASON_LINE_REGEX = new RegExp(
  `^${LEADING_PREFIX}reason:\\s*(.+?)\\s*$`,
  "im",
);

/**
 * Extract the final RESULT marker (and optional `reason:` line) from an
 * assistant text block. Returns `null` when no marker is present.
 */
export function parseResultMarker(text: string | undefined): ResultMarker | null {
  if (!text) return null;

  // Find the LAST marker match (reset lastIndex since we use /g).
  MARKER_LINE_REGEX.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = MARKER_LINE_REGEX.exec(text)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;

  const outcome = lastMatch[1].toLowerCase() as RunOutcome;
  const marker: ResultMarker = { outcome };

  // Look for a `reason:` line in the remainder of the message after the
  // marker. Only attach it for non-`done` outcomes — a reason on `done`
  // is allowed but ignored (the summary captures it).
  if (outcome !== "done") {
    const after = text.slice(lastMatch.index + lastMatch[0].length);
    const reasonMatch = after.match(REASON_LINE_REGEX);
    if (reasonMatch?.[1]) {
      marker.reason = reasonMatch[1].trim();
    }
  }

  return marker;
}

/**
 * Remove the RESULT marker (and any `reason:` line that immediately
 * follows it) from an assistant text block so the remaining content can
 * be used as a completion summary. Preserves all other content.
 *
 * Safe to call when no marker is present — returns the input unchanged.
 */
export function stripResultMarker(text: string): string {
  if (!text) return text;

  // Drop the last marker line and any reason: line that follows.
  // We do this as a two-pass regex to be robust to arbitrary whitespace.
  let out = text;

  // Strip all marker lines (usually just one, but defensive in case the
  // LLM echoed it twice).
  out = out.replace(MARKER_LINE_REGEX, "").replace(/^[ \t]*\n/gm, (match, offset, src) => {
    // Only collapse consecutive blank lines that appear at positions we
    // just blanked — avoid collapsing legitimate paragraph breaks.
    const before = src.slice(Math.max(0, offset - 2), offset);
    return before.endsWith("\n\n") ? "" : match;
  });

  // Strip a trailing reason: line (only the last one — matching where
  // we just removed the marker).
  out = out.replace(/\n[ \t>`*]*reason:[^\n]*$/im, "");

  return out.trim();
}
