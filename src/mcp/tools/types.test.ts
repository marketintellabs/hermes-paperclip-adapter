/**
 * Tests for the shared tool-result + error-classification helpers.
 *
 * These helpers are the backbone of the MCP server's contract with the
 * LLM: every tool funnels failures through them, and the LLM bases its
 * retry behavior on the `retryPolicy` hint they attach. Breaking any of
 * these assertions quietly would flip production agents from "give up
 * cleanly" to "infinite retry loop" (or vice versa) — worth the tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyHttp,
  errorResult,
  ERROR_PREFIXES,
  okResult,
  ScopeViolation,
} from "./types.js";

describe("classifyHttp", () => {
  it("401/403 → abort (auth is wired by the adapter, LLM can't fix)", () => {
    assert.equal(classifyHttp(401), "abort");
    assert.equal(classifyHttp(403), "abort");
  });

  it("404 → fix-args (likely a wrong id the LLM can correct)", () => {
    assert.equal(classifyHttp(404), "fix-args");
  });

  it("429 → retry (rate limit, back off and try again)", () => {
    assert.equal(classifyHttp(429), "retry");
  });

  it("5xx → retry (server-side transient)", () => {
    assert.equal(classifyHttp(500), "retry");
    assert.equal(classifyHttp(502), "retry");
    assert.equal(classifyHttp(503), "retry");
  });

  it("other 4xx → fix-args (bad body/params)", () => {
    assert.equal(classifyHttp(400), "fix-args");
    assert.equal(classifyHttp(422), "fix-args");
  });

  it("unexpected (e.g. 399) → retry (safe default, avoids dead-ending)", () => {
    assert.equal(classifyHttp(399), "retry");
    assert.equal(classifyHttp(0), "retry");
  });
});

describe("okResult", () => {
  it("passes plain strings through unchanged", () => {
    assert.deepEqual(okResult("hello"), { text: "hello" });
  });

  it("stringifies objects as pretty JSON so the LLM can parse them", () => {
    const r = okResult({ id: "ABC", status: "open" });
    assert.equal(r.isError, undefined);
    assert.ok(r.text.includes('"id": "ABC"'));
    assert.ok(r.text.includes('"status": "open"'));
  });

  it("handles arrays", () => {
    const r = okResult([1, 2, 3]);
    assert.ok(r.text.includes("1"));
    assert.ok(r.text.includes("3"));
  });
});

describe("errorResult", () => {
  it("defaults to retryPolicy=abort (safest: stop, don't loop)", () => {
    const r = errorResult("something broke");
    assert.equal(r.isError, true);
    assert.equal(r.retryPolicy, "abort");
    assert.ok(r.text.includes("[retryPolicy=abort]"));
  });

  it("respects an explicit retryPolicy", () => {
    const r = errorResult("rate limited", "retry");
    assert.equal(r.retryPolicy, "retry");
    assert.ok(r.text.includes("[retryPolicy=retry]"));
  });

  it("appends details payload when provided (keeps signal for LLM recovery)", () => {
    const r = errorResult("bad args", "fix-args", {
      field: "issueId",
      reason: "must be non-empty",
    });
    assert.ok(r.text.includes("bad args"));
    assert.ok(r.text.includes("[retryPolicy=fix-args]"));
    assert.ok(r.text.includes('"field": "issueId"'));
  });

  // ─── Anti-hallucination prefix vocabulary (0.9.3+) ──────────────────
  // The leading [ARGS REJECTED — MCP server is healthy; ...] / [TRANSIENT
  // FAILURE — ...] / [NON-RECOVERABLE — ...] tags pre-empt the
  // unreachable-server hallucination observed in the 2026-05-03 LinkedIn
  // Strategist run-4c6fc85b post-mortem. Every tool error must lead with
  // its policy-keyed prefix; the SDK-validation interception in
  // server.ts uses the same vocabulary so the LLM sees one consistent
  // shape across all failure modes.

  it("fix-args result LEADS WITH the ARGS REJECTED prefix (anti-hallucination)", () => {
    const r = errorResult("scope violation", "fix-args");
    assert.ok(
      r.text.startsWith(ERROR_PREFIXES["fix-args"]),
      "fix-args text must lead with the ARGS REJECTED prefix so the LLM cannot misread it as a network failure",
    );
    // The 'MCP server is healthy' anchor is the load-bearing phrase —
    // pre-empts the unreachable-server hallucination.
    assert.match(r.text, /MCP server is healthy/);
  });

  it("retry result LEADS WITH the TRANSIENT FAILURE prefix", () => {
    const r = errorResult("rate limited", "retry");
    assert.ok(r.text.startsWith(ERROR_PREFIXES.retry));
    assert.match(r.text, /TRANSIENT FAILURE/);
  });

  it("abort result LEADS WITH the NON-RECOVERABLE prefix", () => {
    const r = errorResult("auth failed");
    assert.ok(r.text.startsWith(ERROR_PREFIXES.abort));
    assert.match(r.text, /NON-RECOVERABLE/);
    assert.match(r.text, /Do NOT retry/);
  });

  it("prefixes are exhaustive — one per retryPolicy value", () => {
    // Defensive: if a new retryPolicy is added to the union without a
    // prefix entry, this catches it before production sees an undefined
    // prefix concatenated into the error text.
    const policies: Array<"fix-args" | "retry" | "abort"> = ["fix-args", "retry", "abort"];
    for (const p of policies) {
      assert.ok(
        ERROR_PREFIXES[p] && ERROR_PREFIXES[p].startsWith("["),
        `missing or malformed prefix for retryPolicy=${p}`,
      );
    }
  });
});

describe("ScopeViolation", () => {
  it("captures both ids so the handler can log structured scope context", () => {
    const err = new ScopeViolation("other-id", "my-id");
    assert.equal(err.name, "ScopeViolation");
    assert.equal(err.issueId, "other-id");
    assert.equal(err.scope, "my-id");
    assert.ok(err.message.includes("other-id"));
    assert.ok(err.message.includes("my-id"));
  });

  it("is an Error instance (so instanceof checks in tools work)", () => {
    const err = new ScopeViolation("x", "y");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ScopeViolation);
  });
});
