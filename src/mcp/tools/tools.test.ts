/**
 * Tests for the four Paperclip MCP tools.
 *
 * Strategy: construct a fake {@link PaperclipClient} whose methods record
 * their arguments and return canned values (or throw canned errors),
 * then drive each tool's `execute` directly. No MCP SDK, no stdio, no
 * real HTTP. The tools are the security boundary of the adapter — every
 * branch (scope, API error, classifier mapping) is worth a test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PaperclipClient, PaperclipConfig } from "../client.js";
import { PaperclipClientError } from "../client.js";
import type { ToolContext } from "./types.js";
import { ScopeViolation } from "./types.js";
import { listMyIssuesTool } from "./list-my-issues.js";
import { getIssueTool } from "./get-issue.js";
import { postIssueCommentTool } from "./post-issue-comment.js";
import { createSubIssueTool } from "./create-sub-issue.js";

// ─── Fake client + ctx ────────────────────────────────────────────────────

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

/**
 * Build a fake client backed by a route map. Each route returns either
 * a value (resolved) or a {@link PaperclipClientError} (rejected).
 * Undeclared routes throw a loud "unexpected call" assertion to catch
 * drift between tests and tool paths.
 */
function fakeClient(
  cfg: Partial<PaperclipConfig>,
  routes: Record<string, unknown | Error>,
): { client: PaperclipClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const run = (call: RecordedCall) => {
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    if (!(key in routes)) {
      throw new Error(`unexpected client call: ${key}`);
    }
    const val = routes[key];
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
      async get(path, query) {
        return run({ method: "GET", path, query: query as Record<string, unknown> }) as never;
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

/** Build a ToolContext with either an open scope or a bound scope. */
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

// ─── list_my_issues ───────────────────────────────────────────────────────

describe("list_my_issues", () => {
  it("filters terminal statuses by default and trims to { id, title, ... }", async () => {
    const { client, calls } = fakeClient(
      { agentId: "ag-1", companyId: "co-1" },
      {
        "GET /companies/co-1/issues": [
          { id: "i1", identifier: "MAR-1", title: "open", status: "todo", priority: 2 },
          { id: "i2", identifier: "MAR-2", title: "working", status: "in_progress", priority: 1 },
          { id: "i3", identifier: "MAR-3", title: "closed", status: "done", priority: 3 },
          { id: "i4", identifier: "MAR-4", title: "killed", status: "cancelled", priority: 4 },
        ],
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await listMyIssuesTool.execute({}, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].query, { assigneeAgentId: "ag-1" });
    const parsed = JSON.parse(result.text) as Array<{ identifier: string }>;
    assert.deepEqual(parsed.map((i) => i.identifier), ["MAR-1", "MAR-2"]);
  });

  it("includes terminal issues when includeDone=true", async () => {
    const { client } = fakeClient(
      { agentId: "ag-1", companyId: "co-1" },
      {
        "GET /companies/co-1/issues": [
          { id: "i1", identifier: "MAR-1", title: "t", status: "todo" },
          { id: "i3", identifier: "MAR-3", title: "t", status: "done" },
        ],
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await listMyIssuesTool.execute({ includeDone: true }, ctx);
    const parsed = JSON.parse(result.text) as Array<{ identifier: string }>;
    assert.deepEqual(parsed.map((i) => i.identifier), ["MAR-1", "MAR-3"]);
  });

  it("returns errorResult with abort when agentId/companyId are missing", async () => {
    // Missing env is an adapter-wiring bug, not something the LLM can fix
    // by retrying — aborting signals "stop and surface this upstream".
    const { client } = fakeClient({}, {});
    const { ctx } = fakeCtx(client);
    const result = await listMyIssuesTool.execute({}, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
  });

  it("maps 500 response to retryPolicy=retry", async () => {
    const { client } = fakeClient(
      { agentId: "ag-1", companyId: "co-1" },
      {
        "GET /companies/co-1/issues": new PaperclipClientError(
          "GET",
          "/companies/co-1/issues",
          500,
          { error: "boom" },
          "boom",
        ),
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await listMyIssuesTool.execute({}, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "retry");
  });
});

// ─── get_issue ────────────────────────────────────────────────────────────

describe("get_issue", () => {
  it("fetches the issue without comments by default", async () => {
    const { client, calls } = fakeClient(
      {},
      { "GET /issues/MAR-42": { id: "MAR-42", title: "hi" } },
    );
    const { ctx } = fakeCtx(client);
    const result = await getIssueTool.execute({ issueId: "MAR-42" }, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.match(result.text, /MAR-42/);
  });

  it("fetches comments when includeComments=true (separate request)", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "GET /issues/MAR-42": { id: "MAR-42" },
        "GET /issues/MAR-42/comments": [{ id: "c1", body: "hey" }],
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await getIssueTool.execute(
      { issueId: "MAR-42", includeComments: true },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 2);
    assert.match(result.text, /"comments"/);
  });

  it("is NOT scope-restricted — reads to other issues succeed", async () => {
    // Reads are open by design (R3 in ADAPTER_REDESIGN.md): an agent
    // scoped to MAR-30 may need to read a blocking/linked issue like
    // MAR-99 for context. If this assertion breaks, delegation workflows
    // silently break with it.
    const { client } = fakeClient({}, { "GET /issues/MAR-99": { id: "MAR-99" } });
    const { ctx } = fakeCtx(client, "MAR-30");
    const result = await getIssueTool.execute({ issueId: "MAR-99" }, ctx);
    assert.equal(result.isError, undefined);
  });

  it("maps 404 to retryPolicy=fix-args (wrong id, LLM can correct)", async () => {
    const { client } = fakeClient(
      {},
      {
        "GET /issues/bogus": new PaperclipClientError(
          "GET",
          "/issues/bogus",
          404,
          null,
          "not found",
        ),
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await getIssueTool.execute({ issueId: "bogus" }, ctx);
    assert.equal(result.retryPolicy, "fix-args");
  });
});

// ─── post_issue_comment (scope-restricted write) ──────────────────────────

describe("post_issue_comment", () => {
  it("happy path: calls POST /issues/{id}/comments with the body", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "POST /issues/MAR-30/comments": {
          id: "c-new",
          body: "making progress",
          createdAt: "2026-04-04T00:00:00Z",
        },
      },
    );
    const { ctx } = fakeCtx(client, "MAR-30");
    const result = await postIssueCommentTool.execute(
      { issueId: "MAR-30", body: "making progress" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { body: "making progress" });
  });

  it("SCOPE VIOLATION: rejects writes to any issue other than the bound one", async () => {
    // This is the R3 security boundary. If it ever fails, any agent can
    // write to any issue — the multi-agent system stops being safe.
    const { client, calls } = fakeClient({}, {});
    const { ctx, logs } = fakeCtx(client, "MAR-30");
    const result = await postIssueCommentTool.execute(
      { issueId: "MAR-99", body: "should not post" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.match(result.text, /scope violation/);
    assert.equal(calls.length, 0, "must NOT hit the API on scope violation");
    assert.equal(logs[0]?.msg, "post_issue_comment SCOPE_VIOLATION");
  });

  it("scope-open runs (heartbeat, no PAPERCLIP_ISSUE_ID) can post anywhere", async () => {
    // When the adapter doesn't bind a scope (e.g. a heartbeat wake
    // where the agent finds its own work), writes are open. This
    // matches the assertWriteScope contract in server.ts.
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/MAR-17/comments": { id: "c1" } },
    );
    const { ctx } = fakeCtx(client, null);
    const result = await postIssueCommentTool.execute(
      { issueId: "MAR-17", body: "hello" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
  });

  it("401 response → retryPolicy=abort (auth misconfiguration)", async () => {
    const { client } = fakeClient(
      {},
      {
        "POST /issues/MAR-30/comments": new PaperclipClientError(
          "POST",
          "/issues/MAR-30/comments",
          401,
          null,
          "unauthorized",
        ),
      },
    );
    const { ctx } = fakeCtx(client, "MAR-30");
    const result = await postIssueCommentTool.execute(
      { issueId: "MAR-30", body: "x" },
      ctx,
    );
    assert.equal(result.retryPolicy, "abort");
  });
});

// ─── create_sub_issue (scope-restricted on parent) ────────────────────────

describe("create_sub_issue", () => {
  it("happy path: posts to /companies/{companyId}/issues with all fields", async () => {
    const { client, calls } = fakeClient(
      { companyId: "co-1" },
      { "POST /companies/co-1/issues": { id: "new-issue" } },
    );
    const { ctx } = fakeCtx(client, "MAR-30");
    const result = await createSubIssueTool.execute(
      {
        title: "Delegated task",
        description: "Please do the thing.",
        assigneeAgentId: "ag-other",
        parentIssueId: "MAR-30",
        priority: 2,
      },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.title, "Delegated task");
    assert.equal(body.assigneeAgentId, "ag-other");
    assert.equal(body.parentIssueId, "MAR-30");
    assert.equal(body.priority, 2);
  });

  it("allows top-level (parentless) creation — delegation without chaining", async () => {
    // New top-level work is a valid delegation pattern. The scope guard
    // only fires when parentIssueId is set to an issue other than the
    // caller's own. Lose this and agents can't spin off unrelated work.
    const { client, calls } = fakeClient(
      { companyId: "co-1" },
      { "POST /companies/co-1/issues": { id: "new-issue" } },
    );
    const { ctx } = fakeCtx(client, "MAR-30");
    const result = await createSubIssueTool.execute(
      {
        title: "New standalone",
        description: "go",
        assigneeAgentId: "ag-other",
      },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.parentIssueId, undefined);
  });

  it("SCOPE VIOLATION: rejects parentIssueId that isn't the bound issue", async () => {
    const { client, calls } = fakeClient({ companyId: "co-1" }, {});
    const { ctx, logs } = fakeCtx(client, "MAR-30");
    const result = await createSubIssueTool.execute(
      {
        title: "Delegated",
        description: "hi",
        assigneeAgentId: "ag-other",
        parentIssueId: "MAR-99",
      },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.equal(calls.length, 0);
    assert.equal(logs[0]?.msg, "create_sub_issue SCOPE_VIOLATION");
  });

  it("returns abort when companyId is missing (adapter wiring bug)", async () => {
    const { client } = fakeClient({}, {});
    const { ctx } = fakeCtx(client);
    const result = await createSubIssueTool.execute(
      { title: "t", description: "d", assigneeAgentId: "ag" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
  });
});
