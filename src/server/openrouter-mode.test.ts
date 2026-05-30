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
  DEFAULT_FREE_MODELS_BY_TIER,
  FALLBACK_FREE_MODEL,
  FREE_PROVIDER,
} from "./openrouter-mode.js";

const SUPER_FREE = DEFAULT_FREE_MODELS_BY_TIER.super;
const NANO_FREE = DEFAULT_FREE_MODELS_BY_TIER.nano;

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

describe("openrouter-mode: resolveFreeModel (per-tier)", () => {
  it("does NOT use the openrouter/free meta-router (slow NVIDIA routing)", () => {
    for (const v of Object.values(DEFAULT_FREE_MODELS_BY_TIER)) {
      assert.notEqual(v, "openrouter/free");
      assert.ok(v.endsWith(":free"), `${v} should be a :free slug`);
    }
    assert.ok(FALLBACK_FREE_MODEL.endsWith(":free"));
  });

  it("returns the per-tier default when no override", () => {
    assert.equal(resolveFreeModel({}, "super"), SUPER_FREE);
    assert.equal(resolveFreeModel({}, "nano"), NANO_FREE);
    assert.equal(resolveFreeModel({}, "opus"), DEFAULT_FREE_MODELS_BY_TIER.opus);
  });

  it("returns the fallback for an unknown/missing tier", () => {
    assert.equal(resolveFreeModel({}, "mystery"), FALLBACK_FREE_MODEL);
    assert.equal(resolveFreeModel({}, undefined), FALLBACK_FREE_MODEL);
  });

  it("honors the global OPENROUTER_FREE_MODEL override for every tier", () => {
    const env = { OPENROUTER_FREE_MODEL: "  pinned/model:free " };
    assert.equal(resolveFreeModel(env, "super"), "pinned/model:free");
    assert.equal(resolveFreeModel(env, "nano"), "pinned/model:free");
  });

  it("per-tier override beats the global override and the default", () => {
    const env = {
      OPENROUTER_FREE_MODEL: "global/model:free",
      OPENROUTER_FREE_MODEL_SUPER: " tier/super-model:free ",
    };
    assert.equal(resolveFreeModel(env, "super"), "tier/super-model:free");
    // nano has no per-tier override -> falls through to the global one
    assert.equal(resolveFreeModel(env, "nano"), "global/model:free");
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

  it("frees super -> the fast super free model", () => {
    const r = resolveModelMode({ env, tier: "super", configuredModel: "deepseek/deepseek-v3.2" });
    assert.equal(r.overridden, true);
    assert.equal(r.model, SUPER_FREE);
    assert.equal(r.provider, FREE_PROVIDER);
    assert.equal(r.auxiliary.compression?.model, SUPER_FREE);
    assert.equal(r.auxiliary.session_search?.provider, FREE_PROVIDER);
  });

  it("frees nano -> the low-latency nano free model (different from super)", () => {
    const r = resolveModelMode({ env, tier: "nano", configuredModel: "google/gemini-2.5-flash-lite" });
    assert.equal(r.overridden, true);
    assert.equal(r.model, NANO_FREE);
    assert.notEqual(NANO_FREE, SUPER_FREE, "super and nano must use different free models (rate-limit spread)");
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

  it("honors a per-tier runtime free-model override", () => {
    const r = resolveModelMode({
      env: { OPENROUTER_MODE: "hybrid", OPENROUTER_FREE_MODEL_NANO: "custom/nano:free" },
      tier: "nano",
      configuredModel: "google/gemini-2.5-flash-lite",
    });
    assert.equal(r.model, "custom/nano:free");
    assert.equal(r.auxiliary.vision?.model, "custom/nano:free");
  });
});

describe("openrouter-mode: resolveModelMode — free_only", () => {
  const env = { OPENROUTER_MODE: "free_only" };

  it("frees every tier with its tier-specific fast free model", () => {
    for (const tier of ["opus", "quality", "super", "nano", "glm"]) {
      const r = resolveModelMode({ env, tier, configuredModel: "z-ai/glm-4.7" });
      assert.equal(r.overridden, true, `tier ${tier} should be freed`);
      assert.equal(r.model, DEFAULT_FREE_MODELS_BY_TIER[tier]);
    }
  });

  it("frees an unknown tier with the fallback model", () => {
    const r = resolveModelMode({ env, tier: "mystery", configuredModel: "z-ai/glm-4.7" });
    assert.equal(r.overridden, true);
    assert.equal(r.model, FALLBACK_FREE_MODEL);
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
    assert.match(banner, new RegExp(`model=deepseek/deepseek-v3\\.2->${SUPER_FREE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});
