/**
 * LLM-API failure classifier.
 *
 * Many of our failed/timed-out heartbeat runs have a perfectly
 * legible cause buried in `parsed.response` (the LLM's final
 * "message" — which, when the LLM provider rejects the call before
 * the agent can produce an answer, becomes the upstream error
 * string verbatim). Examples observed in production:
 *
 *   "API call failed after 3 retries: HTTP 402: This request
 *    requires more credits, or fewer max_tokens. You requested up
 *    to 16384 tokens, but can only afford 8375. To increase, visit
 *    https://openrouter.ai/settings/keys and create a key with a
 *    higher daily limit"
 *
 *   "API call failed (attempt 1/3): APIStatusError [HTTP 402]"
 *
 * Pre-this-module, those failures land in `result_json.result` as a
 * raw blob and `result_json.errorCode` stays unset — the operator
 * has to grep run output to figure out what happened. With the
 * 0.8.20-mil.0 liveness telemetry shipped, we now have a structured
 * place (`nextActionHints[]`) to put actionable next steps. This
 * module bridges the two: it inspects the run's final-message text
 * for known LLM-provider failure modes, classifies each into a
 * stable `errorCode`, and emits a one-line operator hint that says
 * EXACTLY what to do (raise the daily limit, rotate the key, retry
 * later, etc.) instead of what went wrong.
 *
 * Pure function — no I/O, no side effects on the input text. Caller
 * (`execute.ts`) owns the wire-up: when a non-empty classification
 * is returned, it stamps `resultJson.errorCode`, calls
 * `liveness.recordHint(...)`, and (only for the budget / auth
 * cases that definitively kill the run) calls
 * `liveness.markDead(errorCode)` so a `dead` verdict surfaces in
 * dashboards.
 *
 * Pattern set is deliberately narrow at first — every regex has
 * been verified against a real production failure. Add new patterns
 * by harvesting fresh examples from a fleet audit, never speculate.
 */

export type LlmErrorCode =
  | "provider_budget_exhausted"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "llm_call_exhausted_retries";

export interface LlmErrorClassification {
  /** Stable identifier suitable for `resultJson.errorCode`. */
  errorCode: LlmErrorCode;
  /**
   * Operator-facing one-liner explaining the SPECIFIC next action.
   * Suitable for `liveness.recordHint(...)` — gets surfaced in
   * `result_json.nextActionHints[]` and any future dashboard list.
   */
  hint: string;
  /**
   * If true, the failure mode is fatal for the run (the LLM call
   * never produced any agent action) and `liveness.markDead(errorCode)`
   * should fire. Set conservatively — false for transient/retry
   * cases the agent might still recover from on the next wake.
   */
  dead: boolean;
  /**
   * The substring of input that matched. Useful for dashboards
   * that want to show a one-line evidence quote alongside the
   * classification without re-running the match.
   */
  evidence: string;
}

/**
 * Provider-aware hint detail. We embed the provider name when we
 * can detect it from the input or it's passed in by the caller —
 * makes the hint actionable ("rotate ZAI_API_KEY") instead of
 * generic ("rotate the LLM API key").
 */
function detectProvider(text: string, fallback: string | undefined): string {
  // The order matters — match the most specific signature first.
  if (/openrouter\.(ai|com)/i.test(text)) return "openrouter";
  if (/api\.anthropic\.com|x-api-key.*anthropic/i.test(text)) return "anthropic";
  if (/api\.openai\.com/i.test(text)) return "openai";
  if (/deepinfra\.com|huggingface\.co/i.test(text)) return "huggingface";
  return fallback?.trim() || "unknown";
}

/**
 * Single-pass classifier. Inspects `text` (typically
 * `parsed.response` and/or `executionResult.errorMessage`) and
 * returns the first matching classification, or `null` when no
 * known LLM-API failure pattern is present.
 *
 * `provider` is the adapter's resolved provider (`resolvedProvider`
 * in execute.ts) and is used as a fallback when the input text
 * doesn't carry an unambiguous URL. We prefer text-derived provider
 * because Hermes sometimes routes through a meta-router that
 * differs from what `resolvedProvider` reports.
 */
export function classifyLlmError(
  text: string | null | undefined,
  provider?: string,
): LlmErrorClassification | null {
  if (!text || typeof text !== "string") return null;

  // ── 1. HTTP 402 — credit / budget exhaustion ──────────────────────
  // OpenRouter is the dominant emitter (verified in production
  // 2026-05-01 fleet audit: 100+ runs across CEO, Investigative
  // Correspondent, Managing Editor failed with this exact message).
  // The 402 status doubles as "key has no balance" (anthropic /
  // openai) — we treat both the same since the operator's next
  // action is identical (top up the account / raise the daily
  // limit on the key).
  const budget = text.match(
    /HTTP 402[^\n]{0,400}|(?:requires more credits|create a key with a higher daily limit)[^\n]{0,200}/i,
  );
  if (budget) {
    const p = detectProvider(text, provider);
    return {
      errorCode: "provider_budget_exhausted",
      hint:
        `${p} returned HTTP 402 (budget/credit exhausted) — top up the account or raise the daily limit on the key. ` +
        `If this fires repeatedly across a single day, check whether one agent's max_tokens is set too high relative to remaining headroom.`,
      dead: true,
      evidence: budget[0].slice(0, 240),
    };
  }

  // ── 2. HTTP 401 / 403 — auth ──────────────────────────────────────
  // "Unauthorized" / "invalid api key" / "authentication failed" —
  // catches the typical shapes from openrouter, anthropic, openai,
  // and the deepinfra openai-compatible endpoint.
  const auth = text.match(
    /HTTP 40[13][^\n]{0,300}|invalid_api_key[^\n]{0,200}|authentication[^\n]*failed[^\n]{0,200}|Unauthorized[^\n]{0,200}|invalid_x_api_key[^\n]{0,200}/i,
  );
  if (auth) {
    const p = detectProvider(text, provider);
    const envVarHint =
      p === "openrouter"
        ? "OPENROUTER_API_KEY"
        : p === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : p === "openai"
            ? "OPENAI_API_KEY"
            : p === "huggingface"
              ? "HF_TOKEN"
              : `${p.toUpperCase()}_API_KEY`;
    return {
      errorCode: "provider_auth_failed",
      hint:
        `${p} rejected the API key (HTTP 401/403) — rotate ${envVarHint} via Secrets Manager and force-deploy the affected hermes ECS service. ` +
        `If the key was valid recently, check whether it was revoked / regenerated upstream.`,
      dead: true,
      evidence: auth[0].slice(0, 240),
    };
  }

  // ── 3. HTTP 429 — rate limit ──────────────────────────────────────
  // Less fatal than 402/401: the next wake may succeed, so `dead`
  // stays false (the run is failed but "stalled" semantics fits
  // better — operator might want to do nothing and let the next
  // heartbeat retry).
  const rate = text.match(
    /HTTP 429[^\n]{0,300}|rate[\s_-]?limit(?:ed|ing)?[^\n]{0,200}|too[\s-]?many[\s-]?requests[^\n]{0,200}/i,
  );
  if (rate) {
    const p = detectProvider(text, provider);
    return {
      errorCode: "provider_rate_limited",
      hint:
        `${p} rate-limited the run (HTTP 429) — usually transient. If the same agent repeats this on multiple consecutive wakes, ` +
        `consider lowering wake frequency, switching to a less-loaded provider for this agent, or contacting the provider for a higher tier.`,
      dead: false,
      evidence: rate[0].slice(0, 240),
    };
  }

  // ── 4. Generic "failed after N retries" ────────────────────────────
  // Hermes' own retry machinery exhausting its budget without a
  // more-specific status code surfacing. Lower priority than the
  // three above — only fires when nothing else matched. The hint
  // is deliberately broad because we don't know what failed; just
  // signals the operator that the run is gone for a non-budget,
  // non-auth, non-rate-limit reason.
  const exhausted = text.match(/failed after \d+ retries[^\n]{0,300}/i);
  if (exhausted) {
    const p = detectProvider(text, provider);
    return {
      errorCode: "llm_call_exhausted_retries",
      hint:
        `${p} LLM call exhausted Hermes' retry budget without resolving — check provider status / network egress, ` +
        `or grep run output for the underlying error code. If this fires across multiple providers simultaneously, suspect outbound network / DNS at the ECS task level.`,
      dead: true,
      evidence: exhausted[0].slice(0, 240),
    };
  }

  return null;
}
