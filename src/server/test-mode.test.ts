/**
 * Tests for the PAPERCLIP_ADAPTER_TEST_MODE flag.
 *
 * The override is purely env-driven and pure-functional (no fs / network),
 * so these tests are lightweight unit checks: feed in a synthetic
 * `process.env`-shaped record, assert on the resolved config and on the
 * formatted banner string the adapter emits at the top of each spawn.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTestModeActive,
  resolveTestModeConfig,
  formatTestModeBanner,
  DEFAULT_TEST_MODEL,
  DEFAULT_TEST_PROVIDER,
} from "./test-mode.js";

describe("test-mode: isTestModeActive", () => {
  it("returns false for unset/empty/zero/false-ish values", () => {
    for (const v of [undefined, "", "0", "false", "no", "off", " "]) {
      assert.equal(
        isTestModeActive({ PAPERCLIP_ADAPTER_TEST_MODE: v }),
        false,
        `expected false for ${JSON.stringify(v)}`,
      );
    }
  });

  it("returns true for canonical truthy values, case- and whitespace-insensitive", () => {
    for (const v of ["1", "true", "TRUE", " true ", "yes", "ON", "On"]) {
      assert.equal(
        isTestModeActive({ PAPERCLIP_ADAPTER_TEST_MODE: v }),
        true,
        `expected true for ${JSON.stringify(v)}`,
      );
    }
  });

  it("ignores unrelated env vars", () => {
    assert.equal(
      isTestModeActive({
        PAPERCLIP_ADAPTER_TEST_MODEL: "google/gemma-4-31b-it:free",
      }),
      false,
    );
  });
});

describe("test-mode: resolveTestModeConfig", () => {
  it("returns inactive config when flag not set", () => {
    const cfg = resolveTestModeConfig({});
    assert.equal(cfg.active, false);
    assert.equal(cfg.model, "");
    assert.equal(cfg.provider, "");
    assert.deepEqual(cfg.auxiliary, {});
    assert.equal(cfg.rawEnv, undefined);
  });

  it("returns active config with defaults when only flag set", () => {
    const cfg = resolveTestModeConfig({ PAPERCLIP_ADAPTER_TEST_MODE: "1" });
    assert.equal(cfg.active, true);
    assert.equal(cfg.model, DEFAULT_TEST_MODEL);
    assert.equal(cfg.provider, DEFAULT_TEST_PROVIDER);
    assert.deepEqual(Object.keys(cfg.auxiliary).sort(), [
      "compression",
      "session_search",
      "title_generation",
      "vision",
    ]);
    for (const slot of Object.values(cfg.auxiliary)) {
      assert.equal(slot.model, DEFAULT_TEST_MODEL);
      assert.equal(slot.provider, DEFAULT_TEST_PROVIDER);
    }
  });

  it("respects explicit model override", () => {
    const cfg = resolveTestModeConfig({
      PAPERCLIP_ADAPTER_TEST_MODE: "true",
      PAPERCLIP_ADAPTER_TEST_MODEL: "google/gemma-4-31b-it:free",
    });
    assert.equal(cfg.active, true);
    assert.equal(cfg.model, "google/gemma-4-31b-it:free");
    assert.equal(cfg.provider, DEFAULT_TEST_PROVIDER);
    for (const slot of Object.values(cfg.auxiliary)) {
      assert.equal(slot.model, "google/gemma-4-31b-it:free");
    }
  });

  it("respects explicit provider override", () => {
    const cfg = resolveTestModeConfig({
      PAPERCLIP_ADAPTER_TEST_MODE: "yes",
      PAPERCLIP_ADAPTER_TEST_PROVIDER: "nous",
    });
    assert.equal(cfg.provider, "nous");
    for (const slot of Object.values(cfg.auxiliary)) {
      assert.equal(slot.provider, "nous");
    }
  });

  it("lets auxiliary be a different free model than main", () => {
    const cfg = resolveTestModeConfig({
      PAPERCLIP_ADAPTER_TEST_MODE: "1",
      PAPERCLIP_ADAPTER_TEST_MODEL: "openrouter/free",
      PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: "google/gemma-4-26b-a4b:free",
    });
    assert.equal(cfg.model, "openrouter/free");
    for (const slot of Object.values(cfg.auxiliary)) {
      assert.equal(slot.model, "google/gemma-4-26b-a4b:free");
    }
  });

  it("trims whitespace from env values", () => {
    const cfg = resolveTestModeConfig({
      PAPERCLIP_ADAPTER_TEST_MODE: "1",
      PAPERCLIP_ADAPTER_TEST_MODEL: "  openrouter/free  ",
      PAPERCLIP_ADAPTER_TEST_PROVIDER: " openrouter ",
    });
    assert.equal(cfg.model, "openrouter/free");
    assert.equal(cfg.provider, "openrouter");
  });

  it("captures rawEnv snapshot for diagnostic logging", () => {
    const cfg = resolveTestModeConfig({
      PAPERCLIP_ADAPTER_TEST_MODE: "1",
      PAPERCLIP_ADAPTER_TEST_MODEL: "x",
      PAPERCLIP_ADAPTER_TEST_PROVIDER: "openrouter",
      PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: undefined,
    });
    assert.deepEqual(cfg.rawEnv, {
      PAPERCLIP_ADAPTER_TEST_MODE: "1",
      PAPERCLIP_ADAPTER_TEST_MODEL: "x",
      PAPERCLIP_ADAPTER_TEST_PROVIDER: "openrouter",
      PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: undefined,
    });
  });
});

describe("test-mode: formatTestModeBanner", () => {
  it("returns empty string when test mode is inactive (defensive)", () => {
    const cfg = resolveTestModeConfig({});
    assert.equal(
      formatTestModeBanner({
        cfg,
        originalModel: "z-ai/glm-4.7",
        originalProvider: "openrouter",
      }),
      "",
    );
  });

  it("includes original + override model and provider", () => {
    const cfg = resolveTestModeConfig({ PAPERCLIP_ADAPTER_TEST_MODE: "1" });
    const banner = formatTestModeBanner({
      cfg,
      originalModel: "z-ai/glm-4.7",
      originalProvider: "openrouter",
      agentName: "ceo",
    });
    assert.match(banner, /\*\*\* TEST MODE ACTIVE \*\*\*/);
    assert.match(banner, /agent=ceo/);
    assert.ok(banner.includes("z-ai/glm-4.7->" + DEFAULT_TEST_MODEL));
    assert.ok(banner.includes("openrouter->" + DEFAULT_TEST_PROVIDER));
    assert.match(banner, /PAPERCLIP_ADAPTER_TEST_MODE=1/);
  });

  it("handles missing original values gracefully", () => {
    const cfg = resolveTestModeConfig({ PAPERCLIP_ADAPTER_TEST_MODE: "1" });
    const banner = formatTestModeBanner({
      cfg,
      originalModel: "",
      originalProvider: "",
    });
    assert.ok(banner.includes("(default)->"));
    assert.ok(banner.includes("(auto)->"));
  });
});
