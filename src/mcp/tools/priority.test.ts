/**
 * Tests for the tolerant priority field (F6 durable fix).
 *
 * Two layers are covered:
 *   1. `coercePriority` — the pure mapping from arbitrary LLM input to
 *      the Paperclip enum or undefined. This is what each tool's
 *      `execute` calls to produce the wire value.
 *   2. `prioritySchema` parsed inside the real tool input objects — the
 *      load-bearing guarantee is that the MCP SDK's pre-execute
 *      `safeParseAsync` can NEVER reject on priority (the chronic
 *      create_sub_issue retry-loop → 600s-timeout failure). We assert
 *      that strings, numbers, and omission all parse successfully.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { coercePriority, prioritySchema } from "./priority.js";
import { createSubIssueTool } from "./create-sub-issue.js";
import { createSubIssuesTool } from "./create-sub-issues.js";

describe("coercePriority", () => {
  it("passes through the API enum strings (case/space-insensitive)", () => {
    assert.equal(coercePriority("critical"), "critical");
    assert.equal(coercePriority("high"), "high");
    assert.equal(coercePriority("medium"), "medium");
    assert.equal(coercePriority("low"), "low");
    assert.equal(coercePriority("  HIGH  "), "high");
    assert.equal(coercePriority("Medium"), "medium");
  });

  it("maps common synonyms onto the enum", () => {
    assert.equal(coercePriority("urgent"), "critical");
    assert.equal(coercePriority("p0"), "critical");
    assert.equal(coercePriority("med"), "medium");
    assert.equal(coercePriority("normal"), "medium");
    assert.equal(coercePriority("p3"), "low");
  });

  it("maps the legacy 0..4 integer scale", () => {
    assert.equal(coercePriority(0), undefined, "0 = no priority → omit");
    assert.equal(coercePriority(1), "critical", "1 = urgent");
    assert.equal(coercePriority(2), "high");
    assert.equal(coercePriority(3), "medium");
    assert.equal(coercePriority(4), "low");
  });

  it("maps numeric strings on the legacy scale", () => {
    assert.equal(coercePriority("2"), "high");
    assert.equal(coercePriority(" 4 "), "low");
    assert.equal(coercePriority("0"), undefined);
  });

  it("drops (never throws on) unknown / out-of-range / wrong-type input", () => {
    assert.equal(coercePriority(undefined), undefined);
    assert.equal(coercePriority(null), undefined);
    assert.equal(coercePriority(""), undefined);
    assert.equal(coercePriority("banana"), undefined);
    assert.equal(coercePriority(9), undefined);
    assert.equal(coercePriority(-1), undefined);
    assert.equal(coercePriority(2.5), undefined, "non-integer is not a legacy code");
    assert.equal(coercePriority({}), undefined);
    assert.equal(coercePriority([]), undefined);
    assert.equal(coercePriority(true), undefined);
  });
});

describe("prioritySchema tolerance (SDK pre-execute parse never rejects)", () => {
  it("accepts a string priority", () => {
    const r = prioritySchema.safeParse("high");
    assert.equal(r.success, true);
  });

  it("accepts a numeric priority", () => {
    const r = prioritySchema.safeParse(2);
    assert.equal(r.success, true);
  });

  it("accepts omission (undefined)", () => {
    const r = prioritySchema.safeParse(undefined);
    assert.equal(r.success, true);
  });
});

describe("tool input objects never reject on priority", () => {
  // The MCP SDK builds z.object(tool.inputSchema) and safeParseAsync's
  // the LLM args against it before execute runs. Reconstruct that object
  // and prove every priority shape parses — a rejection here is exactly
  // the failure F6 removes.
  const base = {
    title: "Delegate something",
    description: "Do the thing with full context.",
    assigneeAgentId: "ag-1",
  };

  const singular = z.object(createSubIssueTool.inputSchema);
  const bulk = z.object(createSubIssuesTool.inputSchema);

  for (const p of ["high", "urgent", "medium", 2, 0, "banana", 99] as const) {
    it(`create_sub_issue parses priority=${JSON.stringify(p)}`, () => {
      const r = singular.safeParse({ ...base, parentIssueId: "MAR-1", priority: p });
      assert.equal(r.success, true);
    });
  }

  it("create_sub_issue parses with priority omitted", () => {
    const r = singular.safeParse({ ...base, parentIssueId: "MAR-1" });
    assert.equal(r.success, true);
  });

  it("create_sub_issues parses a child with a string priority", () => {
    const r = bulk.safeParse({
      parentIssueId: "MAR-1",
      subIssues: [{ ...base, priority: "high" }],
    });
    assert.equal(r.success, true);
  });

  it("create_sub_issues parses a child with priority omitted", () => {
    const r = bulk.safeParse({
      parentIssueId: "MAR-1",
      subIssues: [{ ...base }],
    });
    assert.equal(r.success, true);
  });
});
