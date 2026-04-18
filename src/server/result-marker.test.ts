/**
 * Tests for the RESULT marker parser.
 *
 * Run with: `npm test`
 *
 * Uses Node's built-in test runner (node:test) so no dev-dep framework
 * is required. Keep these tests pure — the marker parser is a pure
 * string → object function; no IO, no mocking, no async.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseResultMarker, stripResultMarker } from "./result-marker.js";

describe("parseResultMarker", () => {
  it("returns null for undefined", () => {
    assert.equal(parseResultMarker(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseResultMarker(""), null);
  });

  it("returns null when no marker is present", () => {
    assert.equal(
      parseResultMarker("Some summary of what I did. No marker here."),
      null,
    );
  });

  it("parses a plain RESULT: done marker", () => {
    const m = parseResultMarker("Did the work.\n\nRESULT: done");
    assert.deepEqual(m, { outcome: "done" });
  });

  it("parses RESULT: blocked with reason", () => {
    const m = parseResultMarker(
      "Tried several approaches.\n\nRESULT: blocked\nreason: upstream API returns 500 on every request",
    );
    assert.deepEqual(m, {
      outcome: "blocked",
      reason: "upstream API returns 500 on every request",
    });
  });

  it("parses RESULT: cancelled with reason", () => {
    const m = parseResultMarker(
      "Checked the task.\n\nRESULT: cancelled\nreason: duplicate of MAR-42",
    );
    assert.deepEqual(m, {
      outcome: "cancelled",
      reason: "duplicate of MAR-42",
    });
  });

  it("is case-insensitive on the outcome keyword", () => {
    assert.deepEqual(parseResultMarker("text\nRESULT: Done"), { outcome: "done" });
    assert.deepEqual(parseResultMarker("text\nResult: BLOCKED\nreason: x"), {
      outcome: "blocked",
      reason: "x",
    });
  });

  it("ignores an earlier spurious RESULT: in quoted text and uses the last one", () => {
    const msg = [
      "I was reading a doc that said 'RESULT: blocked'.",
      "But my actual outcome:",
      "",
      "RESULT: done",
    ].join("\n");
    assert.deepEqual(parseResultMarker(msg), { outcome: "done" });
  });

  it("tolerates leading whitespace and markdown-list indicators before RESULT:", () => {
    assert.deepEqual(parseResultMarker("- RESULT: done"), { outcome: "done" });
    assert.deepEqual(parseResultMarker(">  RESULT: blocked\nreason: x"), {
      outcome: "blocked",
      reason: "x",
    });
  });

  it("does not attach reason for outcome=done even if reason: line follows", () => {
    const m = parseResultMarker("RESULT: done\nreason: this should be ignored");
    assert.deepEqual(m, { outcome: "done" });
  });

  it("ignores unknown outcome keywords", () => {
    assert.equal(parseResultMarker("RESULT: pending"), null);
    assert.equal(parseResultMarker("RESULT: success"), null);
  });

  it("requires RESULT: to be on its own line (not inline)", () => {
    assert.equal(
      parseResultMarker("The answer to life is RESULT: done so what now"),
      null,
    );
  });
});

describe("stripResultMarker", () => {
  it("returns empty string unchanged", () => {
    assert.equal(stripResultMarker(""), "");
  });

  it("returns input unchanged when no marker is present", () => {
    const input = "Plain summary without a marker.";
    assert.equal(stripResultMarker(input), input);
  });

  it("removes a trailing RESULT: done marker", () => {
    assert.equal(
      stripResultMarker("Did the work.\n\nRESULT: done"),
      "Did the work.",
    );
  });

  it("removes marker + reason line for blocked", () => {
    const stripped = stripResultMarker(
      "Tried approach A.\nTried approach B.\n\nRESULT: blocked\nreason: external API is down",
    );
    assert.equal(stripped, "Tried approach A.\nTried approach B.");
  });

  it("preserves content before the marker verbatim", () => {
    const summary = [
      "# Summary",
      "",
      "- did thing A",
      "- did thing B",
      "",
      "RESULT: done",
    ].join("\n");
    assert.equal(
      stripResultMarker(summary),
      "# Summary\n\n- did thing A\n- did thing B",
    );
  });
});
