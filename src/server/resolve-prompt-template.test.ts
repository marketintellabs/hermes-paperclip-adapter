import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolvePromptTemplate } from "./execute.js";

// `resolvePromptTemplate` is a tiny but load-bearing function: every
// MIL agent's `adapterConfig.promptTemplate` is `"builtin:mil-heartbeat-v3"`,
// and the resolver decides whether the run picks up the adapter-owned
// status transitions, the paperclip-mcp tool server, and Mustache
// substitution. A regression here silently degrades all 39 agents.
//
// The wrapper-prepend defense was added in 0.8.19-mil.0 after Paperclip
// v2026.428.0 introduced an authGuardPrompt prepend in its hermes_local
// adapter wrapper that broke `raw.startsWith("builtin:")` for our
// builtin references. See `docs/CHANGELOG.md` and the function's
// docstring for context.

describe("resolvePromptTemplate", () => {
  it("returns the default template when raw is undefined", () => {
    const r = resolvePromptTemplate(undefined);
    assert.equal(r.builtinName, null);
    assert.match(r.text, /heartbeat/i);
  });

  it("returns the default template when raw is empty", () => {
    const r = resolvePromptTemplate("");
    assert.equal(r.builtinName, null);
    assert.match(r.text, /heartbeat/i);
  });

  it("resolves a bare builtin reference", () => {
    const r = resolvePromptTemplate("builtin:mil-heartbeat-v3");
    assert.equal(r.builtinName, "mil-heartbeat-v3");
    assert.ok(r.text.length > 0);
    assert.doesNotMatch(r.text, /^builtin:/);
  });

  it("resolves all known builtin templates", () => {
    for (const name of ["mil-heartbeat", "mil-heartbeat-v2", "mil-heartbeat-v3"]) {
      const r = resolvePromptTemplate(`builtin:${name}`);
      assert.equal(r.builtinName, name);
      assert.ok(r.text.length > 0);
    }
  });

  it("throws on unknown builtin name", () => {
    assert.throws(
      () => resolvePromptTemplate("builtin:nope"),
      /Unknown builtin promptTemplate "builtin:nope"/,
    );
  });

  it("trims surrounding whitespace before resolving a bare builtin", () => {
    const r = resolvePromptTemplate("  builtin:mil-heartbeat-v3  \n");
    assert.equal(r.builtinName, "mil-heartbeat-v3");
  });

  it("treats a plain custom template as raw (builtinName=null)", () => {
    const raw = "You are a financial analyst. Do the work.";
    const r = resolvePromptTemplate(raw);
    assert.equal(r.builtinName, null);
    assert.equal(r.text, raw);
  });

  describe("wrapper-prepend defense (Paperclip v2026.428.0+ authGuardPrompt)", () => {
    // Paperclip v2026.428.0's hermes_local adapter wraps our execute()
    // and prepends an authGuardPrompt block to adapterConfig.promptTemplate
    // before passing it through. Without this defense the resolver
    // silently falls into "raw template" mode and disables every
    // builtin behaviour (status transitions, MCP tool plane, Mustache).
    const authGuard = [
      "Paperclip API safety rule:",
      "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
      "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
      "Never use a board, browser, or local-board session for Paperclip API writes.",
    ].join("\n");

    it("recovers `builtin:mil-heartbeat-v3` even when prepended with a Paperclip auth-guard block", () => {
      const wrapped = `${authGuard}\n\nbuiltin:mil-heartbeat-v3`;
      const r = resolvePromptTemplate(wrapped);
      assert.equal(r.builtinName, "mil-heartbeat-v3");
      assert.ok(r.text.length > 0);
      // The resolved text is the BUILTIN file contents, NOT the raw
      // wrapped string. If we returned the wrapped string here, we'd
      // be back in the silent-degradation regression.
      assert.doesNotMatch(r.text, /Paperclip API safety rule/);
    });

    it("recovers builtin reference even with multiple wrapper layers", () => {
      const wrapped = [
        "First wrapper line.",
        "",
        authGuard,
        "",
        "More wrapping.",
        "",
        "builtin:mil-heartbeat-v3",
      ].join("\n");
      const r = resolvePromptTemplate(wrapped);
      assert.equal(r.builtinName, "mil-heartbeat-v3");
    });

    it("ignores `builtin:` text that is not on its own line", () => {
      const raw = "Use builtin:mil-heartbeat-v3 if you want, but here's our custom prompt.";
      const r = resolvePromptTemplate(raw);
      assert.equal(r.builtinName, null);
      assert.equal(r.text, raw);
    });

    it("ignores a `builtin:<unknown-name>` line so unrelated prose can't hijack resolution", () => {
      const raw = [
        "Some custom prompt.",
        "",
        "builtin:made-up-template-name",
        "",
        "More prose.",
      ].join("\n");
      const r = resolvePromptTemplate(raw);
      assert.equal(r.builtinName, null);
      assert.equal(r.text, raw);
    });

    it("picks the first valid builtin reference when multiple lines look like one", () => {
      const raw = [
        "builtin:mil-heartbeat-v2",
        "",
        "builtin:mil-heartbeat-v3",
      ].join("\n");
      const r = resolvePromptTemplate(raw);
      assert.equal(r.builtinName, "mil-heartbeat-v2");
    });

    it("handles CRLF line endings", () => {
      const wrapped = `${authGuard}\r\n\r\nbuiltin:mil-heartbeat-v3`;
      const r = resolvePromptTemplate(wrapped);
      assert.equal(r.builtinName, "mil-heartbeat-v3");
    });

    it("trims the builtin name before lookup", () => {
      const wrapped = `${authGuard}\n\n  builtin:mil-heartbeat-v3   `;
      const r = resolvePromptTemplate(wrapped);
      assert.equal(r.builtinName, "mil-heartbeat-v3");
    });
  });
});
