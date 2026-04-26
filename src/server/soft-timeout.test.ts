/**
 * Tests for soft-timeout plan computation and warning formatting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planSoftTimeout, formatSoftTimeoutWarning } from "./soft-timeout.js";

describe("planSoftTimeout — defaults", () => {
  it("fires at 80% by default for a normal timeout", () => {
    const plan = planSoftTimeout({ timeoutSec: 600 });
    assert.equal(plan.enabled, true);
    assert.equal(plan.delayMs, 480_000);
    assert.equal(plan.threshold, 0.8);
  });

  it("fires at 80% for a short-but-reasonable timeout", () => {
    const plan = planSoftTimeout({ timeoutSec: 60 });
    assert.equal(plan.enabled, true);
    assert.equal(plan.delayMs, 48_000);
  });
});

describe("planSoftTimeout — opt-out", () => {
  it("disables when explicitly opted out", () => {
    const plan = planSoftTimeout({ timeoutSec: 600, enabled: false });
    assert.equal(plan.enabled, false);
  });

  it("disables when timeoutSec is zero or negative", () => {
    assert.equal(planSoftTimeout({ timeoutSec: 0 }).enabled, false);
    assert.equal(planSoftTimeout({ timeoutSec: -1 }).enabled, false);
  });

  it("disables when timeoutSec is too short for a meaningful warning", () => {
    const plan = planSoftTimeout({ timeoutSec: 5 });
    assert.equal(plan.enabled, false);
    assert.equal(plan.delayMs, 4000);
  });

  it("fires for a 7s timeout (5.6s warning is above 5s floor)", () => {
    const plan = planSoftTimeout({ timeoutSec: 7 });
    assert.equal(plan.enabled, true);
    assert.equal(plan.delayMs, 5600);
  });
});

describe("planSoftTimeout — custom threshold", () => {
  it("honours a custom threshold inside (0, 1)", () => {
    const plan = planSoftTimeout({ timeoutSec: 600, threshold: 0.5 });
    assert.equal(plan.threshold, 0.5);
    assert.equal(plan.delayMs, 300_000);
  });

  it("ignores out-of-range thresholds and falls back to 0.8", () => {
    assert.equal(planSoftTimeout({ timeoutSec: 600, threshold: 0 }).threshold, 0.8);
    assert.equal(planSoftTimeout({ timeoutSec: 600, threshold: 1 }).threshold, 0.8);
    assert.equal(planSoftTimeout({ timeoutSec: 600, threshold: -0.5 }).threshold, 0.8);
    assert.equal(planSoftTimeout({ timeoutSec: 600, threshold: 1.5 }).threshold, 0.8);
  });
});

describe("formatSoftTimeoutWarning", () => {
  it("surfaces threshold percentage and timeout", () => {
    const plan = planSoftTimeout({ timeoutSec: 600 });
    const msg = formatSoftTimeoutWarning(plan, 600);
    assert.match(msg, /WARN: soft-timeout reached at 480s/);
    assert.match(msg, /80% of 600s/);
    assert.match(msg, /timeoutSec/);
  });

  it("rounds the percentage to whole numbers for custom thresholds", () => {
    const plan = planSoftTimeout({ timeoutSec: 600, threshold: 0.667 });
    const msg = formatSoftTimeoutWarning(plan, 600);
    assert.match(msg, /67% of 600s/);
  });
});
