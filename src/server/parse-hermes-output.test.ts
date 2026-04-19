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

import { parseHermesOutput, isPlausibleSessionId } from "./execute.js";

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

/**
 * Regression tests for the MAR-30 (2026-04-19) session-id poisoning loop.
 *
 * When Hermes crashes because `--resume <id>` names an unknown session it
 * prints:
 *
 *   Session not found: from
 *   Use a session ID from a previous CLI run (hermes sessions list).
 *
 * The legacy `SESSION_ID_REGEX_LEGACY` used to match the phrase "session ID
 * from" and captured the literal word "from" as a session id. The adapter
 * returned it to Paperclip, Paperclip stored it in `session_id_after`, and
 * the next heartbeat resumed `--resume from` — crash → re-extract → loop.
 */
describe("parseHermesOutput session-id poisoning", () => {
  const hermesResumeFailureStdout = [
    "[paperclip] No project or prior session workspace was available.",
    "[hermes] Starting Hermes Agent",
    "[hermes] Resuming session: from",
    "Session not found: from",
    "Use a session ID from a previous CLI run (hermes sessions list).",
  ].join("\n");

  it("does not extract 'from' as a session id from Hermes resume-failure stderr", () => {
    const parsed = parseHermesOutput(hermesResumeFailureStdout, "");
    assert.equal(
      parsed.sessionId,
      undefined,
      `must not capture false-positive session id; got ${parsed.sessionId}`,
    );
  });

  it("does not extract a session id when stderr shouts 'Session not found'", () => {
    const parsed = parseHermesOutput(
      "some text\n",
      "Session not found: from\nUse a session ID from a previous CLI run.\n",
    );
    assert.equal(parsed.sessionId, undefined);
  });

  it("still extracts a legitimate quiet-mode session id", () => {
    const parsed = parseHermesOutput(
      "response body here\n\nsession_id: 5c6e0e1b-9f47-4d6e-8a5c-a5a9b6a8d1f7\n",
      "",
    );
    assert.equal(parsed.sessionId, "5c6e0e1b-9f47-4d6e-8a5c-a5a9b6a8d1f7");
  });

  it("still extracts a legitimate legacy 'session_id:' session id", () => {
    const parsed = parseHermesOutput(
      "response body\nsession_id: abc123_def456\n",
      "",
    );
    assert.equal(parsed.sessionId, "abc123_def456");
  });
});

describe("isPlausibleSessionId", () => {
  it("rejects null / undefined / empty", () => {
    assert.equal(isPlausibleSessionId(null), false);
    assert.equal(isPlausibleSessionId(undefined), false);
    assert.equal(isPlausibleSessionId(""), false);
  });

  it("rejects short English words (the poisoning vector)", () => {
    for (const w of ["from", "session", "the", "id", "previous", "run"]) {
      assert.equal(
        isPlausibleSessionId(w),
        false,
        `expected "${w}" to be rejected`,
      );
    }
  });

  it("rejects pure-alpha tokens even if long", () => {
    assert.equal(isPlausibleSessionId("abcdefghij"), false);
  });

  it("accepts UUID-shaped ids", () => {
    assert.equal(
      isPlausibleSessionId("5c6e0e1b-9f47-4d6e-8a5c-a5a9b6a8d1f7"),
      true,
    );
  });

  it("accepts alnum ids with digits", () => {
    assert.equal(isPlausibleSessionId("abc123xy"), true);
    assert.equal(isPlausibleSessionId("run_2026_04"), true);
  });
});
