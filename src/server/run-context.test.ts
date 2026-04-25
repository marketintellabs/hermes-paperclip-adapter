import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveRunContextField,
  buildRunContext,
  enrichRunContext,
  readWakeSnapshotTitle,
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

describe("readWakeSnapshotTitle", () => {
  it("reads paperclipWake.issue.title", () => {
    const ctx = makeCtx({
      context: {
        paperclipWake: { issue: { id: "x", title: "Hello world" } },
      },
    });
    assert.equal(readWakeSnapshotTitle(ctx as any), "Hello world");
  });

  it("returns empty string when wake is missing", () => {
    const ctx = makeCtx({ context: {} });
    assert.equal(readWakeSnapshotTitle(ctx as any), "");
  });

  it("returns empty string when issue is missing", () => {
    const ctx = makeCtx({
      context: { paperclipWake: { reason: "issue_assigned" } },
    });
    assert.equal(readWakeSnapshotTitle(ctx as any), "");
  });

  it("ignores non-string title", () => {
    const ctx = makeCtx({
      context: { paperclipWake: { issue: { title: 42 } } },
    });
    assert.equal(readWakeSnapshotTitle(ctx as any), "");
  });
});

describe("enrichRunContext", () => {
  // Real-shape Paperclip context: taskId is set, taskTitle/taskBody are NOT
  // (Paperclip nests title under paperclipWake.issue.title and omits body
  // entirely from the wake snapshot). This is the exact shape that broke
  // the 2026-04-25 Stage 2 smoketest.
  const realShapeContext = {
    source: "issue.create",
    taskId: "issue-uuid-1",
    issueId: "issue-uuid-1",
    paperclipWake: {
      issue: {
        id: "issue-uuid-1",
        title: "Stage 2 smoketest — sub-issue marker inheritance",
        identifier: "MAR-198",
      },
    },
  };

  it("fills taskTitle from wake snapshot without an API call", async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ description: "" }), { status: 200 });
    };
    const ctx = makeCtx({
      context: realShapeContext,
      authToken: "tok",
      config: { paperclipApiUrl: "http://paperclip.test/api" },
    });
    const run = buildRunContext(ctx as any);
    assert.equal(run.taskTitle, "");
    assert.equal(run.taskBody, "");

    const r = await enrichRunContext(run, ctx as any, { fetchImpl });
    assert.equal(run.taskTitle, "Stage 2 smoketest — sub-issue marker inheritance");
    assert.equal(run.provenance.taskTitle, "wake-snapshot");
    assert.ok(r.enrichedFields.includes("taskTitle"));
    // API still fired because body is missing — that's expected.
    assert.equal(fetchCalls, 1);
  });

  it("fills taskBody from API and triggers test-mode marker detection downstream", async () => {
    const apiBody = "<!-- mode: test -->\n\nA smoketest issue body.";
    const fetchImpl = (async (url: any, init: any) => {
      assert.match(String(url), /\/api\/issues\/issue-uuid-1$/);
      assert.equal(init.headers.Authorization, "Bearer tok");
      return new Response(JSON.stringify({ title: "ignored", description: apiBody }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const ctx = makeCtx({
      context: realShapeContext,
      authToken: "tok",
      config: { paperclipApiUrl: "http://paperclip.test" },
    });
    const run = buildRunContext(ctx as any);
    const r = await enrichRunContext(run, ctx as any, { fetchImpl });

    assert.equal(run.taskBody, apiBody);
    assert.equal(run.provenance.taskBody, "api");
    assert.ok(r.enrichedFields.includes("taskBody"));
    assert.equal(r.error, null);
    assert.equal(r.apiStatus, 200);
  });

  it("skips API fetch when taskBody is already populated (no double work)", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const ctx = makeCtx({
      context: { ...realShapeContext, taskTitle: "T", taskBody: "B" },
      authToken: "tok",
      config: { paperclipApiUrl: "http://paperclip.test" },
    });
    const run = buildRunContext(ctx as any);
    const r = await enrichRunContext(run, ctx as any, { fetchImpl });
    assert.equal(fetchCalls, 0);
    assert.equal(r.enrichedFields.length, 0);
  });

  it("returns error=no_auth_token when token is missing (run continues)", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const ctx = makeCtx({
      context: realShapeContext,
      // no authToken
      config: { paperclipApiUrl: "http://paperclip.test" },
    });
    const run = buildRunContext(ctx as any);
    const r = await enrichRunContext(run, ctx as any, { fetchImpl });
    // Wake-snapshot title still filled (no I/O)
    assert.equal(run.taskTitle, "Stage 2 smoketest — sub-issue marker inheritance");
    // Body left empty, error reported
    assert.equal(run.taskBody, "");
    assert.equal(r.error, "no_auth_token");
  });

  it("returns error=http_404 on missing issue (run continues)", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const ctx = makeCtx({
      context: realShapeContext,
      authToken: "tok",
      config: { paperclipApiUrl: "http://paperclip.test" },
    });
    const run = buildRunContext(ctx as any);
    const r = await enrichRunContext(run, ctx as any, { fetchImpl });
    assert.equal(r.error, "http_404");
    assert.equal(r.apiStatus, 404);
    assert.equal(run.taskBody, "");
  });

  it("returns error=timeout when fetch takes longer than timeoutMs", async () => {
    const fetchImpl = (async (_url: any, init: any) => {
      // Wait until aborted, then surface AbortError.
      await new Promise<void>((resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (sig) {
          if (sig.aborted) reject(new DOMException("aborted", "AbortError"));
          sig.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        } else {
          setTimeout(resolve, 5000);
        }
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const ctx = makeCtx({
      context: realShapeContext,
      authToken: "tok",
      config: { paperclipApiUrl: "http://paperclip.test" },
    });
    const run = buildRunContext(ctx as any);
    const r = await enrichRunContext(run, ctx as any, { fetchImpl, timeoutMs: 25 });
    assert.equal(r.error, "timeout");
    assert.equal(run.taskBody, "");
  });

  it("normalizes paperclipApiUrl by appending /api when missing", async () => {
    let observed = "";
    const fetchImpl = (async (url: any) => {
      observed = String(url);
      return new Response(JSON.stringify({ description: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const ctx = makeCtx({
      context: { taskId: "abc" },
      authToken: "tok",
      config: { paperclipApiUrl: "http://paperclip.test/" }, // no /api, trailing slash
    });
    const run = buildRunContext(ctx as any);
    await enrichRunContext(run, ctx as any, { fetchImpl });
    assert.equal(observed, "http://paperclip.test/api/issues/abc");
  });
});
