import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRetryability,
  resolveRetryPolicy,
  formatRetryNotice,
} from "./retry-policy.js";

describe("retry-policy: classifyRetryability", () => {
  it("returns transient=false for successful runs", () => {
    const v = classifyRetryability({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "anything",
      stderr: "",
    });
    assert.equal(v.transient, false);
    assert.equal((v as { reason: string }).reason, "exit_code_zero");
  });

  it("treats hard timeouts as permanent (no retry)", () => {
    const v = classifyRetryability({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "openrouter status: 429",
      stderr: "",
    });
    assert.equal(v.transient, false);
    assert.equal((v as { reason: string }).reason, "hard_timeout");
  });

  it("treats SIGKILLs as permanent", () => {
    const v = classifyRetryability({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stdout: "ECONNRESET",
      stderr: "",
    });
    assert.equal(v.transient, false);
    assert.equal((v as { reason: string }).reason, "sigkilled");
  });

  it("flags openrouter 429 as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: 'OpenRouter responded status 429 "rate limit exceeded"',
    });
    assert.equal(v.transient, true);
    assert.equal((v as { pattern: string }).pattern, "openrouter_429");
  });

  it("flags openrouter 5xx as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "OpenRouter status: 503 service degraded",
    });
    assert.equal(v.transient, true);
    assert.equal((v as { pattern: string }).pattern, "openrouter_5xx");
  });

  it("flags anthropic overloaded_error as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: '{"type":"overloaded_error","message":"Overloaded"}',
    });
    assert.equal(v.transient, true);
    assert.equal((v as { pattern: string }).pattern, "anthropic_overloaded");
  });

  it("flags ECONNRESET as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: socket hang up (ECONNRESET)",
    });
    assert.equal(v.transient, true);
    assert.equal((v as { pattern: string }).pattern, "econnreset");
  });

  it("flags Service Unavailable prose as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "HTTP 503 Service Unavailable",
    });
    assert.equal(v.transient, true);
  });

  it("does NOT flag a generic non-zero exit as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "Something went wrong",
      stderr: "TypeError: undefined is not a function",
    });
    assert.equal(v.transient, false);
    assert.equal((v as { reason: string }).reason, "no_transient_marker");
  });

  it("does NOT flag an arbitrary 'rate' word as transient", () => {
    const v = classifyRetryability({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "the agent computed an interest rate of 5%",
      stderr: "",
    });
    assert.equal(v.transient, false);
  });
});

describe("retry-policy: resolveRetryPolicy", () => {
  it("defaults: enabled with 1 attempt @ 30s", () => {
    const p = resolveRetryPolicy({});
    assert.equal(p.enabled, true);
    assert.equal(p.maxAttempts, 1);
    assert.equal(p.backoffSec, 30);
  });

  it("respects explicit opt-out", () => {
    const p = resolveRetryPolicy({ enabled: false });
    assert.equal(p.enabled, false);
    assert.equal(p.maxAttempts, 0);
  });

  it("clamps maxAttempts to a sensible ceiling", () => {
    const p = resolveRetryPolicy({ maxAttempts: 100 });
    assert.equal(p.maxAttempts, 3);
  });

  it("clamps backoffSec to a sensible ceiling", () => {
    const p = resolveRetryPolicy({ backoffSec: 99999 });
    assert.equal(p.backoffSec, 600);
  });

  it("treats maxAttempts=0 as opt-out", () => {
    const p = resolveRetryPolicy({ maxAttempts: 0 });
    assert.equal(p.enabled, false);
  });

  it("ignores garbage input and falls back to defaults", () => {
    const p = resolveRetryPolicy({
      maxAttempts: NaN as unknown as number,
      backoffSec: -7,
    });
    assert.equal(p.enabled, true);
    assert.equal(p.maxAttempts, 1);
    assert.equal(p.backoffSec, 30);
  });
});

describe("retry-policy: formatRetryNotice", () => {
  it("includes attempt counters and reason", () => {
    const line = formatRetryNotice({
      attempt: 1,
      maxAttempts: 1,
      reason: "transient_marker:openrouter_429",
      backoffSec: 30,
    });
    assert.match(line, /attempt 1\/1/);
    assert.match(line, /reason=transient_marker:openrouter_429/);
    assert.match(line, /sleeping 30s/);
    assert.equal(line.endsWith("\n"), true);
  });
});
