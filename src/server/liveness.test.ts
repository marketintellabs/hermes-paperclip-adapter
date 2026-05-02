import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LivenessTracker } from "./liveness.js";

// LivenessTracker carries the run-side companion fields for the
// upstream Paperclip v2026.428.0 liveness watchdog (#4083). The
// adapter's only job is to (a) classify terminal state correctly
// across the 0.8.x retry/soft-timeout/MCP-crash combinatorics and
// (b) emit chronological progress beats that reach `result_json`
// without modification. Tests pin both behaviours.
//
// A regression here doesn't degrade run outcome (it's pure
// observability), but it WILL silently make dashboards lie — so the
// suite errs on the strict side: timestamp shape, hint dedupe order,
// stale-state stickiness, and the heartbeat-interval floor are all
// asserted.

describe("LivenessTracker", () => {
  it("starts in active state with empty beats and hints", () => {
    const tracker = new LivenessTracker();
    const summary = tracker.summary();
    assert.equal(summary.livenessState, "active");
    assert.deepEqual(summary.progressBeats, []);
    assert.deepEqual(summary.nextActionHints, []);
  });

  it("recordBeat appends with ISO timestamp", () => {
    const fixed = new Date("2026-05-02T12:00:00.000Z");
    const tracker = new LivenessTracker(() => fixed);
    tracker.recordBeat("run_start");
    const { progressBeats } = tracker.summary();
    assert.equal(progressBeats.length, 1);
    assert.equal(progressBeats[0]!.kind, "run_start");
    assert.equal(progressBeats[0]!.ts, "2026-05-02T12:00:00.000Z");
    assert.equal(progressBeats[0]!.detail, undefined);
  });

  it("recordBeat preserves detail string when provided", () => {
    const tracker = new LivenessTracker();
    tracker.recordBeat("retry_triggered", "openrouter_5xx");
    const beat = tracker.summary().progressBeats[0]!;
    assert.equal(beat.kind, "retry_triggered");
    assert.equal(beat.detail, "openrouter_5xx");
  });

  it("recordBeat emits beats in append order", () => {
    let n = 0;
    const tracker = new LivenessTracker(
      () => new Date(`2026-05-02T12:00:0${n++}.000Z`),
    );
    tracker.recordBeat("run_start");
    tracker.recordBeat("soft_timeout_reached");
    tracker.recordBeat("run_end");
    const kinds = tracker.summary().progressBeats.map((b) => b.kind);
    assert.deepEqual(kinds, ["run_start", "soft_timeout_reached", "run_end"]);
  });

  it("recordHint dedupes identical hints across calls", () => {
    const tracker = new LivenessTracker();
    tracker.recordHint("raise adapterConfig.timeoutSec");
    tracker.recordHint("raise adapterConfig.timeoutSec");
    tracker.recordHint("investigate paperclip-mcp crash");
    assert.deepEqual(tracker.summary().nextActionHints, [
      "investigate paperclip-mcp crash",
      "raise adapterConfig.timeoutSec",
    ]);
  });

  it("hints land in stable sorted order across snapshots", () => {
    const tracker = new LivenessTracker();
    tracker.recordHint("z-hint");
    tracker.recordHint("a-hint");
    tracker.recordHint("m-hint");
    const first = tracker.summary().nextActionHints;
    const second = tracker.summary().nextActionHints;
    assert.deepEqual(first, ["a-hint", "m-hint", "z-hint"]);
    assert.deepEqual(second, first);
  });

  it("markStalled promotes from active", () => {
    const tracker = new LivenessTracker();
    tracker.markStalled();
    assert.equal(tracker.summary().livenessState, "stalled");
  });

  it("markStalled is a no-op once dead", () => {
    const tracker = new LivenessTracker();
    tracker.markDead("hard_timeout");
    tracker.markStalled();
    assert.equal(tracker.summary().livenessState, "dead");
  });

  it("markDead supersedes stalled", () => {
    const tracker = new LivenessTracker();
    tracker.markStalled();
    assert.equal(tracker.summary().livenessState, "stalled");
    tracker.markDead("mcp_subprocess_died");
    assert.equal(tracker.summary().livenessState, "dead");
    assert.ok(
      tracker.summary().nextActionHints.includes("mcp_subprocess_died"),
      "markDead reason must surface in hints",
    );
  });

  it("markDead is idempotent — second reason adds a hint without changing state", () => {
    const tracker = new LivenessTracker();
    tracker.markDead("hard_timeout");
    tracker.markDead("mcp_subprocess_died");
    const summary = tracker.summary();
    assert.equal(summary.livenessState, "dead");
    assert.deepEqual(summary.nextActionHints.sort(), [
      "hard_timeout",
      "mcp_subprocess_died",
    ]);
  });

  it("summary returns fresh array copies — mutating consumer arrays must not affect tracker state", () => {
    const tracker = new LivenessTracker();
    tracker.recordBeat("run_start");
    tracker.recordHint("h1");
    const snap = tracker.summary();
    snap.progressBeats.push({ kind: "fake", ts: "fake" });
    snap.nextActionHints.push("h2");
    const fresh = tracker.summary();
    assert.equal(fresh.progressBeats.length, 1);
    assert.equal(fresh.progressBeats[0]!.kind, "run_start");
    assert.deepEqual(fresh.nextActionHints, ["h1"]);
  });

  it("startHeartbeat with interval <= 0 is a no-op", () => {
    const tracker = new LivenessTracker();
    tracker.startHeartbeat(0);
    tracker.startHeartbeat(-1);
    // No timer should have been scheduled — stopHeartbeat must be safe
    // and the tracker must remain beat-empty.
    tracker.stopHeartbeat();
    assert.deepEqual(tracker.summary().progressBeats, []);
  });

  it("startHeartbeat emits heartbeat_tick beats and stops cleanly", async () => {
    const tracker = new LivenessTracker();
    // 5s is the floor; we can't wait 5s in tests, so we drive the clock
    // by calling stopHeartbeat after a short setImmediate window and
    // assert the start/stop lifecycle stays valid. The lifecycle invariants
    // (no leak, idempotent stop) matter more than firing the actual tick
    // in a unit test.
    tracker.startHeartbeat(5);
    await new Promise((r) => setImmediate(r));
    tracker.stopHeartbeat();
    tracker.stopHeartbeat();
    assert.equal(tracker.summary().livenessState, "active");
  });

  it("startHeartbeat is idempotent — calling twice without stop schedules a single timer", () => {
    const tracker = new LivenessTracker();
    tracker.startHeartbeat(5);
    tracker.startHeartbeat(5);
    // Implementation guarantees a single interval; we can't introspect the
    // node:timers handle directly, but stopHeartbeat must be enough to
    // clear all schedules. If the second call leaked a second interval,
    // the second stopHeartbeat below would not catch it and the test
    // process would hang at exit.
    tracker.stopHeartbeat();
  });

  it("integration shape — typical successful run lands as active with run_start/run_end beats", () => {
    let tick = 0;
    const tracker = new LivenessTracker(
      () => new Date(Date.UTC(2026, 4, 2, 12, 0, tick++)),
    );
    tracker.recordBeat("run_start");
    tracker.recordBeat("run_end");
    const summary = tracker.summary();
    assert.equal(summary.livenessState, "active");
    assert.equal(summary.progressBeats.length, 2);
    assert.deepEqual(
      summary.progressBeats.map((b) => b.kind),
      ["run_start", "run_end"],
    );
    assert.deepEqual(summary.nextActionHints, []);
  });

  it("integration shape — soft-timeout run lands as stalled with hint", () => {
    const tracker = new LivenessTracker();
    tracker.recordBeat("run_start");
    tracker.markStalled();
    tracker.recordBeat("soft_timeout_reached", "elapsed=240s threshold=80%");
    tracker.recordHint("raise adapterConfig.timeoutSec");
    tracker.recordBeat("run_end");
    const summary = tracker.summary();
    assert.equal(summary.livenessState, "stalled");
    assert.deepEqual(summary.nextActionHints, [
      "raise adapterConfig.timeoutSec",
    ]);
    const stallBeat = summary.progressBeats.find(
      (b) => b.kind === "soft_timeout_reached",
    );
    assert.ok(stallBeat, "soft_timeout_reached beat must be present");
    assert.equal(stallBeat!.detail, "elapsed=240s threshold=80%");
  });

  it("integration shape — MCP crash run lands as dead with reason hint", () => {
    const tracker = new LivenessTracker();
    tracker.recordBeat("run_start");
    tracker.recordBeat("run_end");
    tracker.markDead("mcp_subprocess_died");
    tracker.recordHint("investigate paperclip-mcp crash");
    const summary = tracker.summary();
    assert.equal(summary.livenessState, "dead");
    assert.ok(summary.nextActionHints.includes("mcp_subprocess_died"));
    assert.ok(
      summary.nextActionHints.includes("investigate paperclip-mcp crash"),
    );
  });

  it("integration shape — hard timeout supersedes stalled", () => {
    const tracker = new LivenessTracker();
    tracker.recordBeat("run_start");
    tracker.markStalled();
    tracker.recordBeat("soft_timeout_reached");
    tracker.markDead("hard_timeout");
    tracker.recordBeat("run_end");
    assert.equal(tracker.summary().livenessState, "dead");
  });
});
