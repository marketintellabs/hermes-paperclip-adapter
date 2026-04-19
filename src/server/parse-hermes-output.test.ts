/**
 * Regression tests for parseHermesOutput error detection.
 *
 * Ticket: MAR-27 (2026-04-19). Paperclip silently marked a successful
 * run as `blocked` because the adapter's error-detection regex matched
 * benign stderr output from Hermes/MCP/camoufox containing the word
 * "error" or "failed". That flipped `runSucceeded` to false and
 * adapter-owned status reconciliation was skipped, leading Paperclip's
 * continuation retry to post an `adapter_failed` signal.
 *
 * These tests pin the new behaviour: only *strong* error signatures
 * populate `errorMessage`. Benign mentions are ignored.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseHermesOutput } from "./execute.js";

describe("parseHermesOutput error detection", () => {
  it("ignores benign 'error' / 'failed' mentions in stderr", () => {
    const benignStderr = [
      "retrying after transient error, attempt 2/3",
      "Tool 'web.search' failed validation, falling back to default",
      "INFO: No error detected in response",
      "camoufox: 404 fetching stealth profile, using bundled fallback",
      "mcp: closed client connection with no error",
      "backend notice: previous job failed health check, restarted",
    ].join("\n");

    const parsed = parseHermesOutput(
      "some agent response\nsession_id: abc123\n",
      benignStderr,
    );

    assert.equal(
      parsed.errorMessage,
      undefined,
      `benign stderr should not populate errorMessage, got: ${parsed.errorMessage}`,
    );
  });

  it("captures real error signatures: 'Error:' line prefix", () => {
    const stderr = "Error: ENOENT: no such file or directory, open '/tmp/x'\n";
    const parsed = parseHermesOutput("ok\n", stderr);
    assert.ok(parsed.errorMessage, "expected errorMessage to be set");
    assert.match(parsed.errorMessage!, /Error: ENOENT/);
  });

  it("captures real error signatures: Python Traceback", () => {
    const stderr = [
      "Traceback (most recent call last):",
      "  File \"/hermes/cli.py\", line 42, in <module>",
      "    main()",
      "RuntimeError: boom",
    ].join("\n");
    const parsed = parseHermesOutput("", stderr);
    assert.ok(parsed.errorMessage, "expected errorMessage to be set");
    assert.match(parsed.errorMessage!, /Traceback/);
  });

  it("captures real error signatures: 'Fatal:' prefix", () => {
    const parsed = parseHermesOutput("", "Fatal: out of memory\n");
    assert.ok(parsed.errorMessage);
    assert.match(parsed.errorMessage!, /Fatal/);
  });

  it("ignores 'error' inside log lines (INFO/DEBUG/warn)", () => {
    const parsed = parseHermesOutput(
      "",
      "INFO 2026-04-19 04:19:35 hermes: subprocess finished with exit 0, no error\n",
    );
    assert.equal(parsed.errorMessage, undefined);
  });

  it("returns empty errorMessage when stderr is empty", () => {
    const parsed = parseHermesOutput("hello world\n", "");
    assert.equal(parsed.errorMessage, undefined);
  });
});
