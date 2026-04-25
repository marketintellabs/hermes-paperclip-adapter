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
  resolveTestMode,
  probeIssueMode,
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

  it("includes original + override model and provider, source=env", () => {
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
    assert.match(banner, /source=env/);
    assert.match(banner, /detail="PAPERCLIP_ADAPTER_TEST_MODE=1"/);
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

describe("test-mode: probeIssueMode (per-issue marker / intent)", () => {
  it("returns inactive for empty / undefined / non-matching issue", () => {
    assert.equal(probeIssueMode({}).active, false);
    assert.equal(probeIssueMode({ title: "", body: "" }).active, false);
    assert.equal(
      probeIssueMode({
        title: "Daily content pipeline",
        body: "Run the editorial calendar item for today.",
      }).active,
      false,
    );
  });

  it("detects explicit HTML-comment marker in body (preferred form)", () => {
    const r = probeIssueMode({
      title: "Daily content pipeline",
      body: "<!-- mode: test -->\n\nRun a quick check.",
    });
    assert.equal(r.active, true);
    assert.equal(r.source, "issue-marker");
    assert.match(r.sourceDetail || "", /<!--\s*mode\s*:\s*test\s*-->/i);
  });

  it("accepts marker in title too (rare but valid)", () => {
    const r = probeIssueMode({
      title: "Daily pipeline <!-- mode: test -->",
      body: "Whatever.",
    });
    assert.equal(r.active, true);
    assert.equal(r.source, "issue-marker");
  });

  it("matches whitespace and case variants of the marker", () => {
    for (const v of [
      "<!--mode:test-->",
      "<!-- MODE: TEST -->",
      "<!--   mode  :  test   -->",
    ]) {
      assert.equal(
        probeIssueMode({ body: `prefix ${v} suffix` }).active,
        true,
        `expected match for ${v}`,
      );
    }
  });

  it("detects 'smoketest' / 'smoke test' / 'smoke-test' intent in title", () => {
    for (const v of ["smoketest", "smoke test", "smoke-test", "Smoketest", "SMOKE TEST"]) {
      const r = probeIssueMode({ title: `Run a ${v} of the pipeline`, body: "" });
      assert.equal(r.active, true, `expected match for title containing ${v}`);
      assert.equal(r.source, "issue-intent");
      assert.ok((r.sourceDetail || "").startsWith("title:"));
    }
  });

  it("detects 'test mode' intent in body", () => {
    const r = probeIssueMode({
      title: "End-to-end check",
      body: "Run the pipeline in test mode so we don't burn paid credits.",
    });
    assert.equal(r.active, true);
    assert.equal(r.source, "issue-intent");
    assert.ok((r.sourceDetail || "").startsWith("body:"));
  });

  it("detects 'low-cost validation' intent", () => {
    const r = probeIssueMode({
      title: "Run a low-cost validation pass",
      body: "",
    });
    assert.equal(r.active, true);
    assert.equal(r.source, "issue-intent");
  });

  it("explicit marker beats intent (marker wins on conflict)", () => {
    const r = probeIssueMode({
      title: "Smoketest the pipeline",
      body: "<!-- mode: test -->\nfoo",
    });
    assert.equal(r.active, true);
    assert.equal(r.source, "issue-marker");
  });

  it("does NOT match unrelated uses of 'test' (false-positive guard)", () => {
    for (const body of [
      "Test the hypothesis that demand drops on Mondays.",
      "QA test this approach with the editorial team.",
      "Run unit tests after the refactor.",
      "Backtest the strategy against last quarter.",
    ]) {
      assert.equal(
        probeIssueMode({ body }).active,
        false,
        `should NOT match: ${body}`,
      );
    }
  });
});

describe("test-mode: resolveTestMode (combined env + issue)", () => {
  it("env wins over issue intent (operator big-hammer)", () => {
    const cfg = resolveTestMode({
      env: {
        PAPERCLIP_ADAPTER_TEST_MODE: "1",
        PAPERCLIP_ADAPTER_TEST_MODEL: "google/gemma-4-31b-it:free",
      },
      title: "Production daily content pipeline",
      body: "Real production work.",
    });
    assert.equal(cfg.active, true);
    assert.equal(cfg.source, "env");
    assert.equal(cfg.model, "google/gemma-4-31b-it:free");
  });

  it("falls through to issue marker when env not set", () => {
    const cfg = resolveTestMode({
      env: {},
      title: "Smoketest",
      body: "<!-- mode: test -->",
    });
    assert.equal(cfg.active, true);
    assert.equal(cfg.source, "issue-marker");
    assert.equal(cfg.model, DEFAULT_TEST_MODEL);
    assert.equal(cfg.provider, DEFAULT_TEST_PROVIDER);
  });

  it("falls through to issue intent when no marker", () => {
    const cfg = resolveTestMode({
      env: {},
      title: "Run a smoketest of the daily pipeline",
      body: "Just want to confirm wake-on-assign + MCP work end-to-end.",
    });
    assert.equal(cfg.active, true);
    assert.equal(cfg.source, "issue-intent");
  });

  it("returns inactive when neither env nor issue trips test mode", () => {
    const cfg = resolveTestMode({
      env: {},
      title: "Daily content pipeline — Friday week-in-review",
      body: "Synthesise the top 5 stories from this week and publish.",
    });
    assert.equal(cfg.active, false);
    assert.equal(cfg.model, "");
  });

  it("issue-source overrides still produce the same auxiliary slot config", () => {
    const cfg = resolveTestMode({
      env: { PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: "google/gemma-4-26b-a4b:free" },
      title: "Smoketest",
      body: "",
    });
    assert.equal(cfg.active, true);
    assert.equal(cfg.source, "issue-intent");
    for (const slot of Object.values(cfg.auxiliary)) {
      assert.equal(slot.model, "google/gemma-4-26b-a4b:free");
    }
  });

  it("treats null/undefined title and body safely", () => {
    const a = resolveTestMode({ env: {}, title: null, body: null });
    const b = resolveTestMode({ env: {}, title: undefined, body: undefined });
    const c = resolveTestMode({ env: {} });
    assert.equal(a.active, false);
    assert.equal(b.active, false);
    assert.equal(c.active, false);
  });
});

describe("test-mode: banner reflects source for per-issue activation", () => {
  it("renders source=issue-marker with detail when marker fires", () => {
    const cfg = resolveTestMode({
      env: {},
      title: "Smoketest the pipeline",
      body: "<!-- mode: test -->",
    });
    const banner = formatTestModeBanner({
      cfg,
      originalModel: "z-ai/glm-4.7",
      originalProvider: "openrouter",
      agentName: "ceo",
    });
    assert.match(banner, /source=issue-marker/);
    assert.match(banner, /detail="<!--/);
  });

  it("renders source=issue-intent with phrase detail when intent fires", () => {
    const cfg = resolveTestMode({
      env: {},
      title: "Run a low-cost validation today",
      body: "",
    });
    const banner = formatTestModeBanner({
      cfg,
      originalModel: "z-ai/glm-4.7",
      originalProvider: "openrouter",
    });
    assert.match(banner, /source=issue-intent/);
    assert.match(banner, /low-cost validation/);
  });
});
