import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PaperclipClient, PaperclipConfig } from "../client.js";
import { PaperclipClientError } from "../client.js";
import type { ToolContext } from "./types.js";
import { ScopeViolation } from "./types.js";
import { updateIssueStatusTool } from "./update-issue-status.js";

// update_issue_status carries five load-bearing behaviours:
//
//   1. Scope enforcement (assertWriteScope) — adapter-assigned runs can
//      only mark their own assigned issue.
//   2. `reason` required when status=blocked (operationally useless
//      without one — fail fast at the tool boundary).
//   3. Terminal-state guard — refuses to transition out of cancelled or
//      done. Makes operator cleanup durable across heartbeat re-wakes.
//      Idempotent re-asserts (done → done, cancelled → cancelled) are
//      allowed and short-circuit; only state CHANGES are blocked.
//   4. Pre-check read failure does not block legitimate transitions —
//      if GET /issues/:id throws, fall through to the PATCH and let
//      it surface the underlying error with its own retry policy.
//   5. HTTP errors classify into retry policies — 4xx → fix-args,
//      5xx/429 → retry, 401/403 → abort.
//
// The terminal-state guard tests are the focus of this file because
// they're new and motivated a fleet-observed bug (2026-05-03 lockdown
// race). The other behaviours are smoke-tested for completeness.

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

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

describe("update_issue_status — terminal-state guard", () => {
  it("refuses to transition cancelled → done (the fleet-observed bug)", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "GET /issues/MAR-257": { id: "MAR-257", status: "cancelled" },
      },
    );
    const { ctx, logs } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-257", status: "done" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
    assert.match(result.text, /terminal state 'cancelled'/);
    assert.match(result.text, /list_my_issues/);
    // No PATCH must be issued — the guard fires before the write.
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
    // The protection event is logged for observability.
    const protectedLog = logs.find((l) => l.msg === "update_issue_status terminal_state_protected");
    assert.ok(protectedLog, "expected terminal_state_protected log entry");
    assert.deepEqual(protectedLog!.meta, {
      issueId: "MAR-257",
      currentStatus: "cancelled",
      requestedStatus: "done",
    });
  });

  it("refuses to transition done → blocked", async () => {
    const { client, calls } = fakeClient(
      {},
      { "GET /issues/MAR-100": { id: "MAR-100", status: "done" } },
    );
    const { ctx } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-100", status: "blocked", reason: "stale" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
    assert.match(result.text, /terminal state 'done'/);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  });

  it("refuses to transition cancelled → needs_review", async () => {
    const { client, calls } = fakeClient(
      {},
      { "GET /issues/MAR-50": { id: "MAR-50", status: "cancelled" } },
    );
    const { ctx } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-50", status: "needs_review" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
    assert.match(result.text, /terminal state 'cancelled'/);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  });

  it("ALLOWS done → done as an idempotent re-assert (LLM occasionally double-calls)", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "GET /issues/MAR-200": { id: "MAR-200", status: "done" },
        "PATCH /issues/MAR-200": { id: "MAR-200", status: "done" },
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-200", status: "done" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    // GET happens for the precheck, then the PATCH proceeds because
    // current === requested.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[1].method, "PATCH");
  });

  it("ALLOWS the normal case: in_progress → done", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "GET /issues/MAR-300": { id: "MAR-300", status: "in_progress" },
        "PATCH /issues/MAR-300": { id: "MAR-300", status: "done" },
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-300", status: "done" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(calls[1].method, "PATCH");
    assert.deepEqual(calls[1].body, { status: "done" });
  });

  it("ALLOWS the normal case: in_progress → blocked (with reason)", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "GET /issues/MAR-400": { id: "MAR-400", status: "in_progress" },
        "PATCH /issues/MAR-400": { id: "MAR-400", status: "blocked" },
      },
    );
    const { ctx } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-400", status: "blocked", reason: "API key revoked upstream" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls[1].body, {
      status: "blocked",
      statusReason: "API key revoked upstream",
    });
  });

  it("falls through to PATCH when the precheck GET fails (does not block legitimate transitions)", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        "GET /issues/MAR-500": new PaperclipClientError(
          "GET",
          "/issues/MAR-500",
          500,
          null,
          "transient backend hiccup",
        ),
        "PATCH /issues/MAR-500": { id: "MAR-500", status: "done" },
      },
    );
    const { ctx, logs } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-500", status: "done" },
      ctx,
    );
    assert.equal(result.isError, undefined);
    // GET threw, but the PATCH still ran — the guard refuses to over-
    // protect when its own precheck is unreliable.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[1].method, "PATCH");
    const failureLog = logs.find((l) => l.msg === "update_issue_status precheck_read_failed");
    assert.ok(failureLog);
  });
});

describe("update_issue_status — pre-existing behaviour smoke tests", () => {
  it("rejects transition with retryPolicy=fix-args on scope violation", async () => {
    const { client, calls } = fakeClient({}, {});
    const { ctx } = fakeCtx(client, "MAR-7");
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-99", status: "done" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.match(result.text, /scope violation/);
    assert.equal(calls.length, 0);
  });

  it("rejects status=blocked with no reason (operational hygiene)", async () => {
    const { client, calls } = fakeClient({}, {});
    const { ctx } = fakeCtx(client);
    const result = await updateIssueStatusTool.execute(
      { issueId: "MAR-42", status: "blocked" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.match(result.text, /'reason' is required when status=blocked/);
    assert.equal(calls.length, 0);
  });

  it("classifies upstream 422 as fix-args; 500 as retry", async () => {
    // 422 case
    {
      const { client } = fakeClient(
        {},
        {
          "GET /issues/MAR-1": { id: "MAR-1", status: "in_progress" },
          "PATCH /issues/MAR-1": new PaperclipClientError(
            "PATCH",
            "/issues/MAR-1",
            422,
            { error: "invalid status transition" },
            "Unprocessable Entity",
          ),
        },
      );
      const { ctx } = fakeCtx(client);
      const result = await updateIssueStatusTool.execute(
        { issueId: "MAR-1", status: "done" },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.equal(result.retryPolicy, "fix-args");
    }
    // 500 case
    {
      const { client } = fakeClient(
        {},
        {
          "GET /issues/MAR-2": { id: "MAR-2", status: "in_progress" },
          "PATCH /issues/MAR-2": new PaperclipClientError(
            "PATCH",
            "/issues/MAR-2",
            500,
            null,
            "server fart",
          ),
        },
      );
      const { ctx } = fakeCtx(client);
      const result = await updateIssueStatusTool.execute(
        { issueId: "MAR-2", status: "done" },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.equal(result.retryPolicy, "retry");
    }
  });
});
