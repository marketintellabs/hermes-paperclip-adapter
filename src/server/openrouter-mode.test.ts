/**
 * Tests for the OPENROUTER_MODE model toggle.
 *
 * Pure-functional (no fs / network): feed a synthetic `process.env`-shaped
 * record plus a tier and configured model, assert on the resolution and the
 * formatted banner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseOpenRouterMode,
  resolveOpenRouterMode,
  resolveFreeModel,
  resolveModelMode,
  formatModeBanner,
  DEFAULT_FREE_MODEL,
  FREE_PROVIDER,
} from "./openrouter-mode.js";

describe("openrouter-mode: parseOpenRouterMode", () => {
  it("defaults to production for unset/empty", () => {
    for (const v of [undefined, "", "   "]) {
      const r = parseOpenRouterMode(v);
      assert.equal(r.mode, "production");
      assert.equal(r.recognized, true);
    }
  });

  it("parses the three valid modes case/space-insensitively", () => {
    assert.deepEqual(parseOpenRouterMode("production"), { mode: "production", recognized: true });
    assert.deepEqual(parseOpenRouterMode(" HYBRID "), { mode: "hybrid", recognized: true });
    assert.deepEqual(parseOpenRouterMode("Free_Only"), { mode: "free_only", recognized: true });
  });

  it("falls back to production (recognized=false) on a typo", () => {
    const r = parseOpenRouterMode("hyrbid");
    assert.equal(r.mode, "production");
    assert.equal(r.recognized, false);
  });

  it("resolveOpenRouterMode reads OPENROUTER_MODE from env", () => {
    assert.equal(resolveOpenRouterMode({ OPENROUTER_MODE: "hybrid" }), "hybrid");
    assert.equal(resolveOpenRouterMode({}), "production");
  });
});

describe("openrouter-mode: resolveFreeModel", () => {
  it("defaults to the openrouter/free meta-router", () => {
    assert.equal(resolveFreeModel({}), DEFAULT_FREE_MODEL);
    assert.equal(DEFAULT_FREE_MODEL, "openrouter/free");
  });

  it("is overridable at runtime via OPENROUTER_FREE_MODEL", () => {
    assert.equal(
      resolveFreeModel({ OPENROUTER_FREE_MODEL: "  meta-llama/llama-3.3-70b-instruct:free " }),
      "meta-llama/llama-3.3-70b-instruct:free",
    );
  });
});

describe("openrouter-mode: resolveModelMode — production", () => {
  it("is identity for every tier (no override)", () => {
    for (const tier of ["opus", "quality", "super", "nano", "glm", undefined]) {
      const r = resolveModelMode({
        env: { OPENROUTER_MODE: "production" },
        tier,
        configuredModel: "deepseek/deepseek-v3.2",
        configuredProvider: "openrouter",
      });
      assert.equal(r.overridden, false, `tier ${tier} should not be overridden`);
      assert.equal(r.model, "deepseek/deepseek-v3.2");
      assert.equal(r.provider, "openrouter");
      assert.deepEqual(r.auxiliary, {});
    }
  });

  it("is the default when OPENROUTER_MODE is unset", () => {
    const r = resolveModelMode({
      env: {},
      tier: "super",
      configuredModel: "deepseek/deepseek-v3.2",
    });
    assert.equal(r.mode, "production");
    assert.equal(r.overridden, false);
  });
});

describe("openrouter-mode: resolveModelMode — hybrid", () => {
  const env = { OPENROUTER_MODE: "hybrid" };

  it("frees the super and nano worker tiers", () => {
    for (const tier of ["super", "nano"]) {
      const r = resolveModelMode({ env, tier, configuredModel: "deepseek/deepseek-v3.2" });
      assert.equal(r.overridden, true, `tier ${tier} should be freed`);
      assert.equal(r.model, DEFAULT_FREE_MODEL);
      assert.equal(r.provider, FREE_PROVIDER);
      assert.equal(r.auxiliary.compression?.model, DEFAULT_FREE_MODEL);
      assert.equal(r.auxiliary.session_search?.provider, FREE_PROVIDER);
    }
  });

  it("keeps the reasoning/writing tiers paid (opus, quality, glm)", () => {
    for (const tier of ["opus", "quality", "glm"]) {
      const r = resolveModelMode({ env, tier, configuredModel: "z-ai/glm-4.7", configuredProvider: "openrouter" });
      assert.equal(r.overridden, false, `tier ${tier} should stay paid`);
      assert.equal(r.model, "z-ai/glm-4.7");
    }
  });

  it("keeps an unknown/missing tier paid (never accidentally downgrade)", () => {
    for (const tier of [undefined, "", "mystery"]) {
      const r = resolveModelMode({ env, tier, configuredModel: "anthropic/claude-sonnet-4.6" });
      assert.equal(r.overridden, false);
      assert.equal(r.model, "anthropic/claude-sonnet-4.6");
    }
  });

  it("honors the runtime free-model override", () => {
    const r = resolveModelMode({
      env: { OPENROUTER_MODE: "hybrid", OPENROUTER_FREE_MODEL: "google/gemini-2.0-flash-exp:free" },
      tier: "nano",
      configuredModel: "google/gemini-2.5-flash-lite",
    });
    assert.equal(r.model, "google/gemini-2.0-flash-exp:free");
    assert.equal(r.auxiliary.vision?.model, "google/gemini-2.0-flash-exp:free");
  });
});

describe("openrouter-mode: resolveModelMode — free_only", () => {
  const env = { OPENROUTER_MODE: "free_only" };

  it("frees every tier, including opus and unknown tiers", () => {
    for (const tier of ["opus", "quality", "super", "nano", "glm", undefined, "mystery"]) {
      const r = resolveModelMode({ env, tier, configuredModel: "z-ai/glm-4.7" });
      assert.equal(r.overridden, true, `tier ${tier} should be freed`);
      assert.equal(r.model, DEFAULT_FREE_MODEL);
    }
  });
});

describe("openrouter-mode: formatModeBanner", () => {
  it("returns empty string when not overridden", () => {
    const r = resolveModelMode({ env: { OPENROUTER_MODE: "production" }, tier: "super", configuredModel: "x" });
    assert.equal(formatModeBanner({ res: r, originalModel: "x", originalProvider: "openrouter" }), "");
  });

  it("emits a grep-able banner with mode, tier, and original->effective model", () => {
    const r = resolveModelMode({ env: { OPENROUTER_MODE: "hybrid" }, tier: "super", configuredModel: "deepseek/deepseek-v3.2", configuredProvider: "openrouter" });
    const banner = formatModeBanner({
      res: r,
      originalModel: "deepseek/deepseek-v3.2",
      originalProvider: "openrouter",
      agentName: "Head of Research",
    });
    assert.match(banner, /\*\*\* OPENROUTER_MODE=hybrid \*\*\*/);
    assert.match(banner, /agent=Head of Research/);
    assert.match(banner, /tier=super/);
    assert.match(banner, /model=deepseek\/deepseek-v3\.2->openrouter\/free/);
  });
});
