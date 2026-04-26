/**
 * Env-var unwrapping helper.
 *
 * Background
 * ----------
 * Paperclip wraps env vars configured through `adapterConfig.env`
 * before passing them to the adapter when the entry was created via
 * the secret-ref UI. The shape is:
 *
 *   { ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-…" } }
 *
 * The pre-0.8.18 adapter used `Object.assign(env, userEnv)`, which
 * copies the wrapper object verbatim. Hermes then sees
 * `ANTHROPIC_API_KEY=[object Object]` and the run fails with an
 * authentication error that's not obviously connected to the
 * configuration UI.
 *
 * In practice the bug has been latent in our deployment: every key
 * that matters is set via the ECS task-definition (container env),
 * not via Paperclip's per-agent secret refs, so the wrapped path is
 * never exercised. But the next operator who reaches for the
 * "Secrets" tab to inject a one-off API key will hit it. Cherry-
 * picked from upstream NousResearch PR #29 (open since 2026-03,
 * never merged); credit @lucasproko for the original report.
 *
 * Contract
 * --------
 * Accepts `unknown` since we have no real type guarantee from
 * Paperclip. Returns a `Record<string, string>` ready to be merged
 * into `process.env`-shaped maps:
 *
 *   - Plain string values pass through.
 *   - `{ value: "..." }` shape (with optional `type`) is unwrapped.
 *   - Anything else (numbers, nested objects without `value`, null,
 *     undefined, arrays) is dropped silently — Hermes inherits
 *     nothing for that key. Logging the drop here would be too
 *     noisy on every run; callers that care can check
 *     `unwrappedKeyCount` against `inputKeyCount`.
 *
 * Pure function — no I/O, no `process.env` mutation. The caller
 * owns merging into the spawn env.
 */

export interface UnwrapResult {
  /** Successfully resolved string-valued entries. */
  env: Record<string, string>;
  /**
   * Keys that were present on the input but couldn't be resolved
   * (e.g. wrapper without `value`, non-string `value`, nested
   * objects). Useful for the caller to log a single warning if
   * non-zero.
   */
  droppedKeys: string[];
}

/**
 * Unwrap user-supplied env vars from `adapterConfig.env` shape.
 *
 * Defensive against:
 *   - The classic `Object.assign(env, userEnv)` regression — a wrapper
 *     object collapses to `[object Object]` if not unwrapped.
 *   - A wrapper with a `value` field of the wrong type.
 *   - A non-object `userEnv` (caller might pass `null`).
 */
export function unwrapUserEnv(userEnv: unknown): UnwrapResult {
  const env: Record<string, string> = {};
  const droppedKeys: string[] = [];

  if (!userEnv || typeof userEnv !== "object" || Array.isArray(userEnv)) {
    return { env, droppedKeys };
  }

  for (const [key, raw] of Object.entries(userEnv)) {
    if (typeof raw === "string") {
      env[key] = raw;
      continue;
    }
    if (raw && typeof raw === "object") {
      const wrapper = raw as { value?: unknown };
      if (typeof wrapper.value === "string") {
        env[key] = wrapper.value;
        continue;
      }
    }
    droppedKeys.push(key);
  }

  return { env, droppedKeys };
}
