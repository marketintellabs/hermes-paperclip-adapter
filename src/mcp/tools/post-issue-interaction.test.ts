import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import type { PaperclipClient, PaperclipConfig } from "../client.js";
import { PaperclipClientError } from "../client.js";
import type { ToolContext } from "./types.js";
import { ScopeViolation } from "./types.js";
import { postIssueInteractionTool } from "./post-issue-interaction.js";

// post_issue_interaction is a thin pass-through to Paperclip's
// `POST /issues/:id/interactions` (BETA endpoint), but the wrapper
// carries three load-bearing behaviours the LLM cannot bypass:
//
//   1. Scope enforcement (assertWriteScope). On adapter-assigned runs
//      the LLM must not be able to attach an interaction to a
//      different issue than the one the run was scoped to.
//   2. sourceRunId injection from PAPERCLIP_RUN_ID env. Persisted
//      records always trace back to the heartbeat run that posted
//      them, even if the LLM doesn't supply the field.
//   3. Retry-policy classification. 4xx → fix-args (LLM should change
//      args before retrying), 5xx → retry, auth → abort.
//
// Each branch gets a test below. Payload validation lives upstream
// (the adapter forwards the kind-specific payload opaquely), so we
// don't re-test schema shapes here — only the wrapper's behaviour.

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

// PAPERCLIP_RUN_ID guard — many tests need to control this env var
// without leaking into other suites in the same test runner. Save the
// original at file-load and restore on every call.
const originalRunId = process.env.PAPERCLIP_RUN_ID;
function withRunId<T>(runId: string | undefined, fn: () => T): T {
  if (runId === undefined) {
    delete process.env.PAPERCLIP_RUN_ID;
  } else {
    process.env.PAPERCLIP_RUN_ID = runId;
  }
  try {
    return fn();
  } finally {
    if (originalRunId === undefined) {
      delete process.env.PAPERCLIP_RUN_ID;
    } else {
      process.env.PAPERCLIP_RUN_ID = originalRunId;
    }
  }
}
after(() => {
  if (originalRunId === undefined) delete process.env.PAPERCLIP_RUN_ID;
  else process.env.PAPERCLIP_RUN_ID = originalRunId;
});

describe("post_issue_interaction", () => {
  it("posts a request_confirmation interaction and returns the persisted record", async () => {
    const persisted = {
      id: "int-1",
      kind: "request_confirmation",
      status: "pending",
    };
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/issue-abc/interactions": persisted },
    );
    const { ctx } = fakeCtx(client);

    const result = await withRunId("run-xyz", () =>
      postIssueInteractionTool.execute(
        {
          issueId: "issue-abc",
          kind: "request_confirmation",
          payload: {
            version: 1,
            prompt: "Publish the LinkedIn draft now?",
            acceptLabel: "Publish",
            rejectLabel: "Hold",
          },
          idempotencyKey: "linkedin-publish-2026-05-02",
          title: "Publish LinkedIn draft",
          summary: "Tier-2 approval gate before posting.",
          continuationPolicy: "none",
        },
        ctx,
      ),
    );

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.path, "/issues/issue-abc/interactions");
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.kind, "request_confirmation");
    assert.equal(body.idempotencyKey, "linkedin-publish-2026-05-02");
    assert.equal(body.title, "Publish LinkedIn draft");
    assert.equal(body.continuationPolicy, "none");
    assert.equal(body.sourceRunId, "run-xyz");
    assert.deepEqual(body.payload, {
      version: 1,
      prompt: "Publish the LinkedIn draft now?",
      acceptLabel: "Publish",
      rejectLabel: "Hold",
    });
    const parsed = JSON.parse(result.text);
    assert.deepEqual(parsed, persisted);
  });

  it("forwards a suggest_tasks payload opaquely (adapter does not re-validate the kind-specific schema)", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/issue-1/interactions": { id: "int-2" } },
    );
    const { ctx } = fakeCtx(client);

    await withRunId("run-1", () =>
      postIssueInteractionTool.execute(
        {
          issueId: "issue-1",
          kind: "suggest_tasks",
          payload: {
            version: 1,
            tasks: [
              { clientKey: "k1", title: "Draft outline" },
              { clientKey: "k2", title: "Write intro" },
            ],
          },
        },
        ctx,
      ),
    );

    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.kind, "suggest_tasks");
    assert.deepEqual(body.payload, {
      version: 1,
      tasks: [
        { clientKey: "k1", title: "Draft outline" },
        { clientKey: "k2", title: "Write intro" },
      ],
    });
  });

  it("omits sourceRunId when PAPERCLIP_RUN_ID env is unset", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/i1/interactions": { id: "int-3" } },
    );
    const { ctx } = fakeCtx(client);

    await withRunId(undefined, () =>
      postIssueInteractionTool.execute(
        {
          issueId: "i1",
          kind: "ask_user_questions",
          payload: {
            version: 1,
            questions: [
              {
                id: "q1",
                prompt: "Pick one",
                selectionMode: "single",
                options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
              },
            ],
          },
        },
        ctx,
      ),
    );

    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.sourceRunId, undefined);
  });

  it("omits empty optional fields (idempotencyKey/title/summary) instead of forwarding null", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/i1/interactions": { id: "int-4" } },
    );
    const { ctx } = fakeCtx(client);

    await withRunId(undefined, () =>
      postIssueInteractionTool.execute(
        {
          issueId: "i1",
          kind: "request_confirmation",
          payload: { version: 1, prompt: "ok?" },
        },
        ctx,
      ),
    );

    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal("idempotencyKey" in body, false);
    assert.equal("title" in body, false);
    assert.equal("summary" in body, false);
    assert.equal("continuationPolicy" in body, false);
  });

  it("rejects with retryPolicy=fix-args when scope is bound to a different issue", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/i-other/interactions": { id: "should-never-fire" } },
    );
    const { ctx, logs } = fakeCtx(client, "i-bound");

    const result = await postIssueInteractionTool.execute(
      {
        issueId: "i-other",
        kind: "request_confirmation",
        payload: { version: 1, prompt: "ok?" },
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.match(result.text, /scope violation/i);
    // Critically: NO HTTP call must have been made.
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => l.msg === "post_issue_interaction SCOPE_VIOLATION"));
  });

  it("classifies upstream 422 (BETA payload-shape mismatch) as fix-args and forwards the API body", async () => {
    const upstreamErr = new PaperclipClientError(
      "POST",
      "/issues/i1/interactions",
      422,
      { issues: [{ path: ["payload", "prompt"], message: "Required" }] },
      "validation failed",
    );
    const { client } = fakeClient(
      {},
      { "POST /issues/i1/interactions": upstreamErr },
    );
    const { ctx } = fakeCtx(client);

    const result = await postIssueInteractionTool.execute(
      {
        issueId: "i1",
        kind: "request_confirmation",
        payload: { version: 1 },
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "fix-args");
    assert.match(result.text, /422/);
    // Upstream body must be forwarded so the LLM can read the
    // specific zod path that failed and fix its next attempt.
    // /s flag so the regex spans the pretty-printed newlines that
    // ToolResult.text inherits from JSON.stringify(value, null, 2).
    assert.match(result.text, /payload[\s\S]*prompt/);
  });

  it("classifies upstream 5xx as retry", async () => {
    const upstreamErr = new PaperclipClientError(
      "POST",
      "/issues/i1/interactions",
      503,
      undefined,
      "service unavailable",
    );
    const { client } = fakeClient(
      {},
      { "POST /issues/i1/interactions": upstreamErr },
    );
    const { ctx } = fakeCtx(client);

    const result = await postIssueInteractionTool.execute(
      {
        issueId: "i1",
        kind: "request_confirmation",
        payload: { version: 1, prompt: "ok?" },
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "retry");
    assert.match(result.text, /503/);
  });

  it("classifies upstream 401/403 as abort (auth failure — adapter wires auth, the LLM cannot fix it)", async () => {
    const upstreamErr = new PaperclipClientError(
      "POST",
      "/issues/i1/interactions",
      401,
      undefined,
      "unauthorized",
    );
    const { client } = fakeClient(
      {},
      { "POST /issues/i1/interactions": upstreamErr },
    );
    const { ctx } = fakeCtx(client);

    const result = await postIssueInteractionTool.execute(
      {
        issueId: "i1",
        kind: "request_confirmation",
        payload: { version: 1, prompt: "ok?" },
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "abort");
  });

  it("classifies network errors (non-PaperclipClientError) as retry", async () => {
    const { client } = fakeClient(
      {},
      { "POST /issues/i1/interactions": new Error("ECONNRESET") },
    );
    const { ctx } = fakeCtx(client);

    const result = await postIssueInteractionTool.execute(
      {
        issueId: "i1",
        kind: "request_confirmation",
        payload: { version: 1, prompt: "ok?" },
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.retryPolicy, "retry");
    assert.match(result.text, /ECONNRESET/);
  });

  it("matches scope when the issue id equals the bound scope", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/i-bound/interactions": { id: "int-5" } },
    );
    const { ctx } = fakeCtx(client, "i-bound");

    const result = await withRunId("run-1", () =>
      postIssueInteractionTool.execute(
        {
          issueId: "i-bound",
          kind: "request_confirmation",
          payload: { version: 1, prompt: "ok?" },
        },
        ctx,
      ),
    );

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
  });

  it("preserves continuationPolicy when explicitly set to wake_assignee", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/i1/interactions": { id: "int-6" } },
    );
    const { ctx } = fakeCtx(client);

    await withRunId(undefined, () =>
      postIssueInteractionTool.execute(
        {
          issueId: "i1",
          kind: "request_confirmation",
          payload: { version: 1, prompt: "ok?" },
          continuationPolicy: "wake_assignee",
        },
        ctx,
      ),
    );

    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.continuationPolicy, "wake_assignee");
  });

  it("treats explicit null on title/summary/idempotencyKey the same as omission", async () => {
    const { client, calls } = fakeClient(
      {},
      { "POST /issues/i1/interactions": { id: "int-7" } },
    );
    const { ctx } = fakeCtx(client);

    await withRunId(undefined, () =>
      postIssueInteractionTool.execute(
        {
          issueId: "i1",
          kind: "request_confirmation",
          payload: { version: 1, prompt: "ok?" },
          title: null,
          summary: null,
          idempotencyKey: null,
        },
        ctx,
      ),
    );

    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal("title" in body, false);
    assert.equal("summary" in body, false);
    assert.equal("idempotencyKey" in body, false);
  });
});
