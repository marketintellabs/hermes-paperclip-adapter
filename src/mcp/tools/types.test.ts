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
