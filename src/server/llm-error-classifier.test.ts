import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyLlmError } from "./llm-error-classifier.js";

// The classifier is the post-run telemetry enrichment that bridges
// the 0.8.20-mil.0 liveness machinery with the LLM-provider failure
// strings that have been silently bleeding into `result_json.result`
// for months. Each test case below is anchored on a real failure
// blob harvested from a production run during the 2026-05-02 fleet
// audit. NEVER add a speculative pattern — every `match()` regex in
// `llm-error-classifier.ts` MUST trace to a verified production
// example, otherwise we risk flipping an unrelated future error into
// the wrong errorCode and misleading the operator.

describe("classifyLlmError", () => {
  describe("HTTP 402 — budget / credit exhaustion", () => {
    // Verbatim from the CEO's 2026-05-01T21:01:01 run on `z-ai/glm-4.7`
    // routed via OpenRouter. Three consecutive scheduled wakes died
    // with exactly this string before today's deploys.
    const realBlob =
      "API call failed after 3 retries: HTTP 402: This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 8375. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher daily limit";

    it("classifies the OpenRouter 402 budget message as provider_budget_exhausted", () => {
      const r = classifyLlmError(realBlob);
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_budget_exhausted");
      assert.equal(r.dead, true);
      assert.match(r.hint, /openrouter/i);
      assert.match(r.hint, /raise the daily limit|top up/i);
      assert.ok(r.evidence.length > 0);
      assert.ok(r.evidence.length <= 240);
    });

    it("detects the provider from the URL even when the caller-supplied fallback is missing", () => {
      const r = classifyLlmError(realBlob);
      if (!r) throw new Error("expected classification, got null");
      assert.match(r.hint, /^openrouter/);
    });

    it("falls back to the caller-supplied provider when no URL is in the blob", () => {
      const blobNoUrl =
        "API call failed: HTTP 402 — This request requires more credits.";
      const r = classifyLlmError(blobNoUrl, "anthropic");
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_budget_exhausted");
      assert.match(r.hint, /^anthropic/);
    });

    it("matches the alternate phrasing 'create a key with a higher daily limit' even without HTTP 402 in the same line", () => {
      const blob = "Visit your dashboard and create a key with a higher daily limit to continue.";
      const r = classifyLlmError(blob, "openrouter");
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_budget_exhausted");
    });
  });

  describe("HTTP 401 / 403 — auth", () => {
    it("classifies HTTP 401 as provider_auth_failed and names the env var", () => {
      const r = classifyLlmError("API call failed: HTTP 401 Unauthorized", "openrouter");
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_auth_failed");
      assert.equal(r.dead, true);
      assert.match(r.hint, /OPENROUTER_API_KEY/);
      assert.match(r.hint, /Secrets Manager/i);
    });

    it("classifies HTTP 403 as provider_auth_failed and uses ANTHROPIC_API_KEY when provider is anthropic", () => {
      const r = classifyLlmError(
        "[error] HTTP 403 forbidden — please check your API key configuration",
        "anthropic",
      );
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_auth_failed");
      assert.match(r.hint, /ANTHROPIC_API_KEY/);
    });

    it("classifies an `invalid_api_key` body as auth even without a status code", () => {
      const r = classifyLlmError(
        '{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}',
        "openai",
      );
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_auth_failed");
      assert.match(r.hint, /OPENAI_API_KEY/);
    });

    it("classifies a HuggingFace auth failure with the HF_TOKEN env-var hint (DeepInfra route)", () => {
      const r = classifyLlmError(
        "Authentication failed at https://api.deepinfra.com/v1/openai/chat/completions",
        "huggingface",
      );
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_auth_failed");
      assert.match(r.hint, /HF_TOKEN/);
    });
  });

  describe("HTTP 429 — rate limit", () => {
    it("classifies HTTP 429 as provider_rate_limited (NOT dead — next wake may succeed)", () => {
      const r = classifyLlmError("HTTP 429 Too Many Requests", "openrouter");
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_rate_limited");
      assert.equal(r.dead, false);
      assert.match(r.hint, /transient|consecutive wakes/i);
    });

    it("matches the lowercase 'rate-limited' phrasing", () => {
      const r = classifyLlmError(
        "the request was rate-limited by the provider",
        "anthropic",
      );
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_rate_limited");
    });

    it("matches 'too many requests' phrased without the HTTP code", () => {
      const r = classifyLlmError("server returned: too many requests in window", "openai");
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_rate_limited");
    });
  });

  describe("'failed after N retries' generic fallback", () => {
    it("matches the bare 'failed after 5 retries' shape with no other code present", () => {
      // No HTTP status, no auth keyword — falls through to the generic
      // exhausted-retries branch.
      const r = classifyLlmError(
        "API call failed after 5 retries: connection reset by peer",
        "huggingface",
      );
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "llm_call_exhausted_retries");
      assert.equal(r.dead, true);
      assert.match(r.hint, /huggingface/);
      assert.match(r.hint, /provider status|outbound network/i);
    });

    it("does NOT eat a 402 — the more-specific budget pattern wins even when 'failed after N retries' is also present", () => {
      // Real production blob has BOTH "failed after 3 retries" AND
      // "HTTP 402"; the budget pattern is checked first and must
      // dominate the classification.
      const real =
        "API call failed after 3 retries: HTTP 402: This request requires more credits";
      const r = classifyLlmError(real, "openrouter");
      if (!r) throw new Error("expected classification, got null");
      assert.equal(r.errorCode, "provider_budget_exhausted");
    });
  });

  describe("non-matches", () => {
    it("returns null for an empty / null / undefined input", () => {
      assert.equal(classifyLlmError(""), null);
      assert.equal(classifyLlmError(null), null);
      assert.equal(classifyLlmError(undefined), null);
    });

    it("returns null for a clean successful response (no failure pattern)", () => {
      const success =
        "I've drafted the LinkedIn post and posted a request_confirmation interaction. Awaiting human approval.";
      assert.equal(classifyLlmError(success, "openrouter"), null);
    });

    it("returns null for a generic non-LLM error (e.g. an MCP tool error message)", () => {
      // Tool errors are classified separately by per-tool retry policy
      // logic — this module only deals with the LLM-API surface.
      const toolErr =
        '{"error":"validation failed","issues":[{"path":["payload","prompt"],"message":"Required"}]}';
      assert.equal(classifyLlmError(toolErr), null);
    });

    it("returns null for a non-string input (defensive)", () => {
      // @ts-expect-error — runtime-shape coverage for whatever the
      // caller passes us; we should never throw on a wrong type.
      assert.equal(classifyLlmError({ not: "a string" }), null);
      // @ts-expect-error
      assert.equal(classifyLlmError(42), null);
    });
  });

  describe("evidence field", () => {
    it("captures the matched substring as evidence (capped at 240 chars)", () => {
      const long =
        "API call failed after 3 retries: HTTP 402: " + "X".repeat(500);
      const r = classifyLlmError(long, "openrouter");
      if (!r) throw new Error("expected classification, got null");
      assert.ok(r.evidence.length <= 240);
      assert.match(r.evidence, /HTTP 402/);
    });
  });
});
