/**
 * Tests for the bulk create_sub_issues tool.
 *
 * Strategy mirrors `tools.test.ts` (same fakeClient + fakeCtx pattern)
 * but split into its own file because the bulk tool deserves a dense
 * cluster of partial-failure / scope / payload-shape tests that would
 * bloat the singular tool's test file. The wire-shape contract
 * (`parentId`, `status: "todo"`) is identical to the singular tool —
 * this file tests that the BATCH path preserves it on every child.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PaperclipClient, PaperclipConfig } from "../client.js";
import { PaperclipClientError } from "../client.js";
import type { ToolContext } from "./types.js";
import { ScopeViolation } from "./types.js";
import {
  createSubIssuesTool,
  MAX_SUB_ISSUES_PER_CALL,
} from "./create-sub-issues.js";

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

/**
 * Fake client that supports per-call dynamic responses via a callback,
 * so a test can return success for some children and an error for
 * others on the same route. (The shared fakeClient in tools.test.ts
 * uses a one-shot routes object — too rigid for partial-failure
 * tests where the same path is hit N times in one call.)
 */
function fakeBatchClient(
  cfg: Partial<PaperclipConfig>,
  resolver: (call: RecordedCall) => unknown | Error,
): { client: PaperclipClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const run = (call: RecordedCall) => {
    calls.push(call);
    const val = resolver(call);
    if (val instanceof Error) throw val;
    return val;
  };

  const config: PaperclipConfig = {
    apiUrl: cfg.apiUrl ?? "http://paperclip.test/api",
    apiKey: cfg.apiKey ?? "jwt-test",
    agentId: cfg.agentId ?? null,
    companyId: cfg.companyId ?? null,
  };

  return {
    calls,
    client: {
      config,
      async get(path) {
        return run({ method: "GET", path }) as never;
      },
      async post(path, body) {
        return run({ method: "POST", path, body }) as never;
      },
      async patch(path, body) {
        return run({ method: "PATCH", path, body }) as never;
      },
    },
  };
}

function fakeCtx(
  client: PaperclipClient,
  scope: string | null = null,
): { ctx: ToolContext; logs: Array<{ msg: string; meta?: unknown }> } {
  const logs: Array<{ msg: string; meta?: unknown }> = [];
  return {
    logs,
    ctx: {
      client,
      log: (msg, meta) => logs.push({ msg, meta }),
      assertWriteScope: (issueId) => {
        if (!scope) return;
        if (issueId === scope) return;
        throw new ScopeViolation(issueId, scope);
      },
    },
  };
}

const SAMPLE = {
  title: "Delegate task",
  description: "Please do the thing.",
  assigneeAgentId: "ag-other",
};

// ─── happy path ───────────────────────────────────────────────────────────

describe("create_sub_issues", () => {
  it("happy path: creates N children in parallel under one parent", async () => {
    let issueCounter = 0;
    const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({
      id: `new-issue-${++issueCounter}`,
    }));
    const { ctx, logs } = fakeCtx(client, "MAR-30");

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "MAR-30",
        subIssues: [
          { ...SAMPLE, title: "Stream A — equities" },
          { ...SAMPLE, title: "Stream B — commodities", priority: 2 },
          { ...SAMPLE, title: "Stream C — crypto" },
        ],
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 3, "one POST per sub-issue");

    // Wire-shape contract: every payload must use `parentId` (not
    // `parentIssueId`) and explicit `status: "todo"`. This is the
    // same contract the singular tool defends — the bulk path must
    // not regress it.
    for (const call of calls) {
      const body = call.body as Record<string, unknown>;
      assert.equal(body.parentId, "MAR-30");
      assert.equal(body.parentIssueId, undefined,
        "bulk path must NOT send parentIssueId — Paperclip silently drops unknown fields");
      assert.equal(body.status, "todo",
        "bulk path must send status=todo so each child fires on_assign");
      assert.equal(body.assigneeAgentId, "ag-other");
    }

    // Priority is preserved per-item (only specified on the second).
    const bodies = calls.map((c) => c.body as Record<string, unknown>);
    assert.equal(bodies[0].priority, undefined);
    assert.equal(bodies[1].priority, 2);
    assert.equal(bodies[2].priority, undefined);

    // Result envelope shape — succeeded count, durationMs, per-item
    // results array.
    const summary = JSON.parse(result.text) as {
      requested: number;
      succeeded: number;
      failed: number;
      results: Array<{ index: number; ok: boolean; issue?: { id: string } }>;
    };
    assert.equal(summary.requested, 3);
    assert.equal(summary.succeeded, 3);
    assert.equal(summary.failed, 0);
    assert.equal(summary.results.length, 3);
    for (const r of summary.results) assert.equal(r.ok, true);

    // Audit log emits a single rollup line — the whole point of
    // collapsing into one tool call.
    const ok = logs.find((l) => l.msg === "create_sub_issues result");
    assert.ok(ok, "must emit create_sub_issues result");
    assert.deepEqual(ok!.meta, {
      parentIssueId: "MAR-30",
      requested: 3,
      ok: 3,
      failed: 0,
      durationMs: (ok!.meta as { durationMs: number }).durationMs,
    });
  });

  it("partial failure: succeeds for healthy children, surfaces error per failed index", async () => {
    let n = 0;
    const { client } = fakeBatchClient({ companyId: "co-1" }, () => {
      n += 1;
      if (n === 2) {
        return new PaperclipClientError(
          "POST",
          "/companies/co-1/issues",
          422,
          { error: "validation" },
          "validation: assigneeAgentId not found",
        );
      }
      return { id: `issue-${n}` };
    });
    const { ctx, logs } = fakeCtx(client, "MAR-30");

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "MAR-30",
        subIssues: [
          { ...SAMPLE, title: "child A" },
          { ...SAMPLE, title: "child B (will fail)" },
          { ...SAMPLE, title: "child C" },
        ],
      },
      ctx,
    );

    // Partial failure is NOT an error — okResult so the LLM can read
    // the per-item array and decide what to retry. Aggregate ok=true
    // for the call as a whole.
    assert.equal(result.isError, undefined);
    const summary = JSON.parse(result.text) as {
      succeeded: number;
      failed: number;
      results: Array<{ index: number; ok: boolean; error?: string; retryPolicy?: string }>;
    };
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.results[0].ok, true);
    assert.equal(summary.results[1].ok, false);
    assert.match(summary.results[1].error!, /422/);
    assert.equal(summary.results[1].retryPolicy, "fix-args",
      "422 should classify as fix-args so the LLM doesn't loop");
    assert.equal(summary.results[2].ok, true);

    const rollup = logs.find((l) => l.msg === "create_sub_issues result")?.meta as {
      ok: number;
      failed: number;
    };
    assert.equal(rollup.ok, 2);
    assert.equal(rollup.failed, 1);
  });

  it("all-failure: surfaces errorResult with worst-case retry policy", async () => {
    const { client } = fakeBatchClient({ companyId: "co-1" }, () => {
      return new PaperclipClientError(
        "POST",
        "/companies/co-1/issues",
        503,
        { error: "upstream" },
        "upstream",
      );
    });
    const { ctx } = fakeCtx(client, "MAR-30");

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "MAR-30",
        subIssues: [
          { ...SAMPLE, title: "a" },
          { ...SAMPLE, title: "b" },
        ],
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "retry",
      "503 across all children should classify as retry");
    assert.match(result.text, /all 2 sub-issue creations failed/);
  });

  it("all-failure: 4xx on any child escalates aggregate retry policy to fix-args", async () => {
    let n = 0;
    const { client } = fakeBatchClient({ companyId: "co-1" }, () => {
      n += 1;
      if (n === 1) {
        return new PaperclipClientError(
          "POST",
          "/companies/co-1/issues",
          400,
          { error: "bad" },
          "bad",
        );
      }
      return new PaperclipClientError(
        "POST",
        "/companies/co-1/issues",
        503,
        { error: "upstream" },
        "upstream",
      );
    });
    const { ctx } = fakeCtx(client, "MAR-30");

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "MAR-30",
        subIssues: [
          { ...SAMPLE, title: "fix-args child" },
          { ...SAMPLE, title: "retry child" },
        ],
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args",
      "presence of any 4xx in all-failure should escalate aggregate to fix-args so the LLM stops looping");
  });

  // ─── input validation / scope ──────────────────────────────────────────

  it("missing parentIssueId is rejected with fix-args (no POSTs)", async () => {
    const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({}));
    const { ctx, logs } = fakeCtx(client, null);

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "",
        subIssues: [{ ...SAMPLE, title: "a" }],
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.equal(calls.length, 0, "must short-circuit before any POST");
    assert.equal(logs[0]?.msg, "create_sub_issues MISSING_PARENT");
  });

  it("missing companyId aborts (adapter wiring bug, not LLM-fixable)", async () => {
    const { client, calls } = fakeBatchClient({}, () => ({}));
    const { ctx } = fakeCtx(client, null);

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "MAR-30",
        subIssues: [{ ...SAMPLE, title: "a" }],
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
    assert.equal(calls.length, 0);
  });

  it("scope violation on parent rejects without any POST", async () => {
    const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({}));
    const { ctx, logs } = fakeCtx(client, "MAR-30");

    const result = await createSubIssuesTool.execute(
      {
        parentIssueId: "MAR-99",
        subIssues: [{ ...SAMPLE, title: "a" }, { ...SAMPLE, title: "b" }],
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.equal(calls.length, 0,
      "scope check must run BEFORE any POST — otherwise children leak past the scope guard");
    const violation = logs.find((l) => l.msg === "create_sub_issues SCOPE_VIOLATION");
    assert.ok(violation);
    assert.deepEqual(violation!.meta, {
      parentIssueId: "MAR-99",
      scope: "MAR-30",
      count: 2,
    });
  });

  it("over-cap protection: runtime check rejects > MAX_SUB_ISSUES_PER_CALL", async () => {
    // Bypass zod by injecting a 12-item array via the function-level
    // type. The tool must still reject — defense in depth in case a
    // future SDK rewrite passes already-parsed input.
    const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({}));
    const { ctx, logs } = fakeCtx(client, "MAR-30");

    const oversized = Array.from({ length: MAX_SUB_ISSUES_PER_CALL + 2 }, (_, i) => ({
      ...SAMPLE,
      title: `child ${i}`,
    }));

    const result = await createSubIssuesTool.execute(
      { parentIssueId: "MAR-30", subIssues: oversized },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.equal(calls.length, 0);
    assert.equal(logs[0]?.msg, "create_sub_issues TOO_MANY");
  });

  // ─── test-mode marker inheritance ──────────────────────────────────────

  describe("test-mode marker inheritance", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_TEST_MODE = "1";
      process.env.PAPERCLIP_TEST_MODE_SOURCE = "issue-marker";
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_TEST_MODE;
      delete process.env.PAPERCLIP_TEST_MODE_SOURCE;
      delete process.env.PAPERCLIP_TEST_MODE_SOURCE_DETAIL;
    });

    it("prepends test-mode marker to every child description", async () => {
      const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({
        id: "new",
      }));
      const { ctx, logs } = fakeCtx(client, "MAR-30");

      await createSubIssuesTool.execute(
        {
          parentIssueId: "MAR-30",
          subIssues: [
            { ...SAMPLE, title: "a", description: "fresh body" },
            { ...SAMPLE, title: "b", description: "another fresh body" },
          ],
        },
        ctx,
      );

      assert.equal(calls.length, 2);
      for (const call of calls) {
        const body = call.body as Record<string, string>;
        assert.match(body.description, /<!--\s*mode\s*:\s*test\s*-->/);
        assert.match(body.description, /inherited from parent: issue-marker/);
      }

      assert.ok(
        logs.some((l) => l.msg === "create_sub_issues test_mode_inherit"),
        "must emit a single rollup test_mode_inherit event for the batch",
      );
    });

    it("idempotent: skips marker prepend if child description already has it", async () => {
      const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({
        id: "new",
      }));
      const { ctx } = fakeCtx(client, "MAR-30");

      await createSubIssuesTool.execute(
        {
          parentIssueId: "MAR-30",
          subIssues: [
            {
              ...SAMPLE,
              title: "a",
              description: "<!-- mode: test -->\nalready marked",
            },
          ],
        },
        ctx,
      );

      const body = calls[0].body as Record<string, string>;
      // Marker appears exactly ONCE — the original one, no duplicate.
      const matches = body.description.match(/<!--\s*mode\s*:\s*test\s*-->/g);
      assert.equal(matches?.length, 1,
        "marker must not be duplicated when child already declares test mode");
    });

    it("uses _SOURCE_DETAIL when set, falling back to _SOURCE then 'parent run'", async () => {
      process.env.PAPERCLIP_TEST_MODE_SOURCE_DETAIL = "intent-phrase: smoketest";
      const { client, calls } = fakeBatchClient({ companyId: "co-1" }, () => ({
        id: "new",
      }));
      const { ctx } = fakeCtx(client, "MAR-30");

      await createSubIssuesTool.execute(
        {
          parentIssueId: "MAR-30",
          subIssues: [{ ...SAMPLE, title: "a" }],
        },
        ctx,
      );

      const body = calls[0].body as Record<string, string>;
      assert.match(body.description, /inherited from parent: intent-phrase: smoketest/);
    });
  });
});
