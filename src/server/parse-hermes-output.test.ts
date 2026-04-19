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

import { parseHermesOutput, isPlausibleSessionId, resolveResumeSessionId } from "./execute.js";

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

describe("resolveResumeSessionId (0.8.3 shape guard)", () => {
  it("returns empty + rejected=false for null/empty", () => {
    assert.deepEqual(resolveResumeSessionId(null), {
      sessionId: "",
      rejected: false,
      reason: "empty",
    });
    assert.deepEqual(resolveResumeSessionId(undefined), {
      sessionId: "",
      rejected: false,
      reason: "empty",
    });
    assert.deepEqual(resolveResumeSessionId(""), {
      sessionId: "",
      rejected: false,
      reason: "empty",
    });
  });

  it("passes through a plausible uuid-style session id (shape-only trust)", () => {
    const uuid = "20260419_211331_fc5725";
    assert.deepEqual(resolveResumeSessionId(uuid), {
      sessionId: uuid,
      rejected: false,
      reason: "ok_shape_only",
    });
  });

  it("passes through a plausible UUID (shape-only trust)", () => {
    const uuid = "5c6e0e1b-9f47-4d6e-8a5c-a5a9b6a8d1f7";
    assert.deepEqual(resolveResumeSessionId(uuid), {
      sessionId: uuid,
      rejected: false,
      reason: "ok_shape_only",
    });
  });

  it("rejects the legacy 'from'-poisoning token", () => {
    // This is the exact value ~3800 heartbeat_runs were poisoned with
    // before the 0.8.2 regex fix. If it ever reappears in session_params,
    // the guard must strip it so Hermes creates a fresh session.
    const r = resolveResumeSessionId("from");
    assert.equal(r.sessionId, "");
    assert.equal(r.rejected, true);
    assert.equal(r.reason, "rejected_shape");
  });

  it("rejects other short english words and fragments", () => {
    for (const w of ["session", "notfound", "error", "none", "abc"]) {
      const r = resolveResumeSessionId(w);
      assert.equal(r.sessionId, "", `should strip ${w}`);
      assert.equal(r.rejected, true, `should flag ${w} as rejected`);
      assert.equal(r.reason, "rejected_shape");
    }
  });

  it("rejects pure-alpha ids that pass length but have no digit/dash/underscore", () => {
    const r = resolveResumeSessionId("abcdefghij");
    assert.equal(r.sessionId, "");
    assert.equal(r.rejected, true);
    assert.equal(r.reason, "rejected_shape");
  });
});

describe("resolveResumeSessionId (0.8.5 state.db existence probe)", () => {
  const GOOD = "20260419_222221_c19d0c";

  it("confirms via probe when session exists", () => {
    const r = resolveResumeSessionId(GOOD, () => ({ exists: true }));
    assert.deepEqual(r, {
      sessionId: GOOD,
      rejected: false,
      reason: "ok_probe_confirmed",
    });
  });

  it("rejects plausibly-shaped ids that aren't in state.db (A.1 regression)", () => {
    // The exact failure mode that drove 0.8.5: a plausibly-shaped
    // session id (passes the 0.8.3 shape guard) that no longer exists
    // on disk and keeps crashing Hermes with `Session not found`.
    const r = resolveResumeSessionId(GOOD, () => ({ exists: false }));
    assert.equal(r.sessionId, "");
    assert.equal(r.rejected, true);
    assert.equal(r.reason, "rejected_not_in_state_db");
  });

  it("propagates probe reason on rejection for diagnostics", () => {
    const r = resolveResumeSessionId(GOOD, () => ({
      exists: false,
      reason: "confirmed-absent-by-test",
    }));
    assert.equal(r.probeDetail, "confirmed-absent-by-test");
  });

  it("fails open when probe returns null (state.db missing / native sqlite err)", () => {
    const r = resolveResumeSessionId(GOOD, () => ({
      exists: null,
      reason: "state.db missing",
    }));
    assert.equal(r.sessionId, GOOD, "resume must proceed when probe is inconclusive");
    assert.equal(r.rejected, false);
    assert.equal(r.reason, "ok_probe_unavailable");
    assert.equal(r.probeDetail, "state.db missing");
  });

  it("does not invoke probe when raw id is absent", () => {
    let called = false;
    const probe = () => {
      called = true;
      return { exists: false };
    };
    resolveResumeSessionId(null, probe);
    assert.equal(called, false, "probe must not run on empty input");
  });

  it("does not invoke probe when raw id fails the shape check", () => {
    let called = false;
    const probe = () => {
      called = true;
      return { exists: true };
    };
    const r = resolveResumeSessionId("from", probe);
    assert.equal(called, false, "probe must short-circuit on shape rejection");
    assert.equal(r.reason, "rejected_shape");
  });
});
