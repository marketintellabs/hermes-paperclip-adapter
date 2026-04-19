import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveRunContextField,
  buildRunContext,
} from "./execute.js";

// Minimal shape matching what execute.ts reads. We intentionally avoid
// importing AdapterExecutionContext from @paperclipai/adapter-utils here so
// these tests exercise the ctx-resolution contract, not the upstream type.
type TestCtx = {
  runId: string;
  agent: { id: string; name: string; companyId: string };
  runtime: Record<string, unknown>;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  authToken?: string;
};

function makeCtx(overrides: Partial<TestCtx> = {}): TestCtx {
  return {
    runId: "test-run",
    agent: { id: "agent-1", name: "Test Agent", companyId: "co-1" },
    runtime: {},
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("resolveRunContextField", () => {
  it("reads from ctx.context when present", () => {
    const ctx = makeCtx({
      context: { taskId: "task-from-context" },
      config: { taskId: "task-from-config" },
    });
    const r = resolveRunContextField(ctx as any, "taskId");
    assert.deepEqual(r, { value: "task-from-context", source: "context" });
  });

  it("falls back to ctx.config when context is missing the key", () => {
    const ctx = makeCtx({
      context: {},
      config: { taskId: "task-from-config" },
    });
    const r = resolveRunContextField(ctx as any, "taskId");
    assert.deepEqual(r, { value: "task-from-config", source: "config" });
  });

  it("returns missing when neither has it", () => {
    const ctx = makeCtx();
    const r = resolveRunContextField(ctx as any, "taskId");
    assert.deepEqual(r, { value: "", source: "missing" });
  });

  it("treats empty strings as missing (so falsy values fall through)", () => {
    const ctx = makeCtx({
      context: { taskId: "" },
      config: { taskId: "task-from-config" },
    });
    const r = resolveRunContextField(ctx as any, "taskId");
    assert.deepEqual(r, { value: "task-from-config", source: "config" });
  });

  it("ignores non-string values (defensive — Paperclip sometimes stores objects)", () => {
    const ctx = makeCtx({
      context: { taskId: 12345 as unknown as string, issueId: { id: "x" } as unknown as string },
      config: { taskId: "task-from-config" },
    });
    const r = resolveRunContextField(ctx as any, "taskId");
    assert.deepEqual(r, { value: "task-from-config", source: "config" });
  });
});

describe("buildRunContext", () => {
  it("prefers ctx.context for real-shape Paperclip runs", () => {
    // Shape lifted from an actual MAR-28 heartbeat-run record:
    //   ctx.context keys: [source, taskId, issueId, taskKey, wakeReason,
    //   wakeSource, wakeTriggerDetail, paperclipHarness…, paperclipWake,
    //   paperclipWorkspace, paperclipWorkspaces]
    const ctx = makeCtx({
      context: {
        source: "assignment",
        taskId: "4473141c-d046-4008-b32a-1d18707eca70",
        issueId: "4473141c-d046-4008-b32a-1d18707eca70",
        taskKey: "MAR-28",
        wakeReason: "issue_assigned",
        wakeSource: "system",
      },
      config: {},
    });
    const run = buildRunContext(ctx as any);
    assert.equal(run.taskId, "4473141c-d046-4008-b32a-1d18707eca70");
    assert.equal(run.provenance.taskId, "context");
    assert.equal(run.wakeReason, "issue_assigned");
    assert.equal(run.provenance.wakeReason, "context");
  });

  it("falls back to ctx.config for legacy callers that set taskTitle/Body there", () => {
    // Older Paperclip builds (and some in-proc test harnesses) merge the
    // per-run fields into adapterConfig instead. We continue to honour
    // that so the fork doesn't regress those callers.
    const ctx = makeCtx({
      context: { taskId: "t1" },
      config: { taskTitle: "Legacy title", taskBody: "Legacy body" },
    });
    const run = buildRunContext(ctx as any);
    assert.equal(run.taskId, "t1");
    assert.equal(run.provenance.taskId, "context");
    assert.equal(run.taskTitle, "Legacy title");
    assert.equal(run.provenance.taskTitle, "config");
    assert.equal(run.taskBody, "Legacy body");
    assert.equal(run.provenance.taskBody, "config");
  });

  it("marks unpopulated fields as 'missing' so logs show where gaps are", () => {
    const ctx = makeCtx({
      context: { taskId: "only-task" },
      config: {},
    });
    const run = buildRunContext(ctx as any);
    assert.equal(run.provenance.taskId, "context");
    assert.equal(run.provenance.taskTitle, "missing");
    assert.equal(run.provenance.commentId, "missing");
    assert.equal(run.provenance.workspaceDir, "missing");
  });

  it("resolves all 8 canonical fields", () => {
    const ctx = makeCtx({
      context: {
        taskId: "t",
        taskTitle: "tt",
        taskBody: "tb",
        commentId: "c",
        wakeReason: "w",
        companyName: "co",
        projectName: "p",
        workspaceDir: "/ws",
      },
    });
    const run = buildRunContext(ctx as any);
    assert.equal(run.taskId, "t");
    assert.equal(run.taskTitle, "tt");
    assert.equal(run.taskBody, "tb");
    assert.equal(run.commentId, "c");
    assert.equal(run.wakeReason, "w");
    assert.equal(run.companyName, "co");
    assert.equal(run.projectName, "p");
    assert.equal(run.workspaceDir, "/ws");
  });
});
