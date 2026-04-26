/**
 * Transient-failure retry policy.
 *
 * Motivation
 * ----------
 * Hermes proxies LLM calls through OpenRouter (or whichever provider is
 * configured). Those upstream calls occasionally fail with transient
 * errors that resolve themselves within seconds — rate-limit 429s,
 * 502/503/504 from a flapping edge, momentary connection resets,
 * "model overloaded" responses from Anthropic during peak windows.
 *
 * Without retry, every one of those events causes a hard run failure.
 * Paperclip then re-tries the *whole heartbeat* on its own cadence,
 * which is fine — except (a) it happens minutes later, (b) it burns
 * the agent's budgeted retry slot, and (c) it surfaces in dashboards
 * as a real failure that an operator may investigate.
 *
 * What this module does
 * ---------------------
 * Classify a finished run as "transient failure", "permanent failure",
 * or "not a failure at all". `execute.ts` consults the classifier
 * after each `runChildProcess` call. On a transient verdict — and only
 * when the operator hasn't opted out and the retry budget isn't
 * exhausted — the adapter sleeps `backoffSec`, logs a `[hermes]
 * retrying after transient failure` line, and respawns Hermes with
 * the same args.
 *
 * Defensive design
 * ----------------
 * - Default budget is **one** retry. Multi-retry storms hide real
 *   provider outages and add cost without value.
 * - Default backoff is 30s — long enough that a 429-rate-limit window
 *   typically clears, short enough that the run still completes
 *   inside a typical 600s hard timeout.
 * - We classify on **strong** signals only. A line containing the
 *   word "rate" is not enough; we require provider-shaped error
 *   markers (HTTP status, OpenRouter error envelope, Anthropic
 *   `overloaded_error`, etc.). False positives here become infinite
 *   retry loops on permanent bugs; we'd rather miss a transient.
 * - Timeouts (`timedOut === true`) are treated as **permanent**.
 *   A run that hit its hard timeout is not a network blip — it
 *   either ran a tight loop or the model legitimately can't finish
 *   in budget. Retrying just doubles the wall clock without
 *   changing the outcome.
 * - `signal === 'SIGKILL'` (the adapter's own enforcement after
 *   graceSec) is also permanent for the same reason.
 */

export type RetryVerdict =
  | { transient: true; reason: string; pattern: string }
  | { transient: false; reason: string };

export interface RetryClassifyInput {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Strong markers for transient upstream LLM failures. These are
 * matched line-by-line against combined stdout+stderr.
 *
 * Each entry is a `{ name, regex }` pair so the verdict carries a
 * stable identifier the caller can log / persist for analytics
 * without having to re-execute the regex on the consumer side.
 */
const TRANSIENT_MARKERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // OpenRouter envelope: "error":{"code":429,…} or status 429/5xx in
  // the OpenRouter response body. Hermes echoes the body verbatim
  // when it gives up.
  { name: "openrouter_429", re: /openrouter[^\n]*\b(?:status|code)["':\s]*429\b/i },
  { name: "openrouter_5xx", re: /openrouter[^\n]*\b(?:status|code)["':\s]*5\d\d\b/i },

  // Anthropic-shaped overloaded error (passes through OpenRouter when
  // the underlying provider is Anthropic).
  { name: "anthropic_overloaded", re: /\boverloaded_error\b/i },
  { name: "anthropic_rate_limit", re: /\brate_limit_error\b/i },

  // Generic HTTP status surfaces. Match only when the line clearly
  // labels the number as a status (avoid matching "PATCH 5xx tools"
  // in a prompt). Both `status: 429` and `HTTP/1.1 503` shapes.
  { name: "http_status_429", re: /\b(?:status|http\/\d\.\d)[\s:][^\n]*\b429\b/i },
  { name: "http_status_502", re: /\b(?:status|http\/\d\.\d)[\s:][^\n]*\b502\b/i },
  { name: "http_status_503", re: /\b(?:status|http\/\d\.\d)[\s:][^\n]*\b503\b/i },
  { name: "http_status_504", re: /\b(?:status|http\/\d\.\d)[\s:][^\n]*\b504\b/i },

  // Provider-side overload prose. These are deliberately conservative;
  // we want strong signals that a human operator would also recognize
  // as transient.
  { name: "provider_overloaded", re: /provider[^\n]*overloaded/i },
  { name: "service_unavailable", re: /\bservice unavailable\b/i },
  { name: "gateway_timeout", re: /\bgateway timeout\b/i },
  { name: "upstream_connect_error", re: /upstream connect error/i },

  // Network-layer flakes that bubble up through the LLM client.
  // Distinct from `ECONNREFUSED` against `localhost` (which is a
  // configuration bug, not a transient).
  { name: "econnreset", re: /\bECONNRESET\b/ },
  { name: "etimedout", re: /\bETIMEDOUT\b/ },
];

/**
 * Decide whether the just-finished run is a candidate for retry.
 *
 * Returns `transient: true` only when ALL of:
 *   - exitCode is non-zero (something failed)
 *   - run was NOT killed by hard timeout
 *   - run was NOT SIGKILLed by the adapter
 *   - at least one transient marker matches stdout+stderr
 *
 * Otherwise returns `transient: false` with a `reason` suitable for
 * inclusion in a structured log.
 */
export function classifyRetryability(input: RetryClassifyInput): RetryVerdict {
  if (input.exitCode === 0) {
    return { transient: false, reason: "exit_code_zero" };
  }
  if (input.timedOut) {
    return { transient: false, reason: "hard_timeout" };
  }
  if (input.signal === "SIGKILL") {
    return { transient: false, reason: "sigkilled" };
  }

  const haystack = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  for (const marker of TRANSIENT_MARKERS) {
    if (marker.re.test(haystack)) {
      return {
        transient: true,
        reason: `transient_marker:${marker.name}`,
        pattern: marker.name,
      };
    }
  }
  return { transient: false, reason: "no_transient_marker" };
}

export interface RetryPolicy {
  /** Whether retries are enabled at all. */
  enabled: boolean;
  /** How many retry attempts may follow the initial run (1 = retry once). */
  maxAttempts: number;
  /** Seconds to sleep between attempts. */
  backoffSec: number;
}

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_BACKOFF_SEC = 30;

interface ResolveOptions {
  enabled?: boolean;
  maxAttempts?: number;
  backoffSec?: number;
}

/**
 * Normalize operator-supplied retry config into a `RetryPolicy`.
 * Anything weird (negative numbers, NaN, non-numeric strings) is
 * snapped to a safe default rather than thrown — the retry feature
 * is observability/quality-of-life, never load-bearing for a run.
 */
export function resolveRetryPolicy(opts: ResolveOptions): RetryPolicy {
  if (opts.enabled === false) {
    return { enabled: false, maxAttempts: 0, backoffSec: 0 };
  }

  const maxAttempts =
    typeof opts.maxAttempts === "number" && Number.isFinite(opts.maxAttempts) && opts.maxAttempts >= 0
      ? Math.min(Math.floor(opts.maxAttempts), 3)
      : DEFAULT_MAX_ATTEMPTS;

  const backoffSec =
    typeof opts.backoffSec === "number" && Number.isFinite(opts.backoffSec) && opts.backoffSec >= 0
      ? Math.min(Math.floor(opts.backoffSec), 600)
      : DEFAULT_BACKOFF_SEC;

  if (maxAttempts === 0) {
    return { enabled: false, maxAttempts: 0, backoffSec };
  }

  return { enabled: true, maxAttempts, backoffSec };
}

/**
 * Format the operator-facing log line written before each retry
 * attempt. Captured in run transcripts so postmortems can correlate
 * a "successful on retry" run with the original transient class.
 */
export function formatRetryNotice(opts: {
  attempt: number;
  maxAttempts: number;
  reason: string;
  backoffSec: number;
}): string {
  return (
    `[hermes] retrying after transient failure (attempt ${opts.attempt}/${opts.maxAttempts}, ` +
    `reason=${opts.reason}, sleeping ${opts.backoffSec}s)\n`
  );
}
