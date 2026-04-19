/**
 * Integration tests for the MCP server wiring.
 *
 * We drive the registered tool handlers directly (via the SDK's
 * `_registeredTools[name].handler` shape — see the tool-invoke smoke
 * test in the PR description) so the tests run synchronously in-process
 * without the stdio transport.
 *
 * The cap is the LAST line of defense against a looping LLM: without it,
 * a tight-loop bug could make hundreds of paid API calls before the
 * adapter timeout fires. That makes it worth an explicit regression
 * test — if the counter ever stops incrementing, we want to find out
 * here, not in a CloudWatch spike.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { buildServer } from "./server.js";
import type { PaperclipClient, PaperclipConfig } from "./client.js";

/**
 * The SDK doesn't export a typed accessor for registered tool handlers,
 * so we reach into `_registeredTools[name].handler`. If this shape ever
 * changes, this type + the reach-in below are the single place to fix
 * it — tools themselves never touch the SDK internals.
 */
interface RegisteredToolInternal {
  handler: (
    args: unknown,
    extra: { signal: AbortSignal },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function reachTool(server: unknown, name: string): RegisteredToolInternal {
  const registered = (server as { _registeredTools: Record<string, RegisteredToolInternal> })
    ._registeredTools;
  const tool = registered[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

function stubClient(): PaperclipClient {
  const config: PaperclipConfig = {
    apiUrl: "http://paperclip.test/api",
    apiKey: "jwt-test",
    agentId: "ag-1",
    companyId: "co-1",
  };
  return {
    config,
    async get() {
      return [] as never;
    },
    async post() {
      return {} as never;
    },
    async patch() {
      return {} as never;
    },
  };
}

describe("buildServer — tool registration", () => {
  it("registers all 4 Paperclip tools by name", () => {
    const server = buildServer({ client: stubClient(), scopedIssueId: null });
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    assert.deepEqual(
      names.sort(),
      ["create_sub_issue", "get_issue", "list_my_issues", "post_issue_comment"],
    );
  });
});

describe("buildServer — MAX_TOOL_CALLS cap", () => {
  it("serves calls up to the cap, then errors with retryPolicy=abort", async () => {
    // Use a cap of 3 so the test finishes quickly + the assertions stay
    // readable. Production cap (20) uses the same code path.
    const server = buildServer({
      client: stubClient(),
      scopedIssueId: null,
      maxToolCalls: 3,
    });
    const getIssue = reachTool(server, "get_issue");
    const signal = new AbortController().signal;

    // Calls 1..3 should succeed (the stub client returns []).
    for (let i = 1; i <= 3; i += 1) {
      const res = await getIssue.handler({ issueId: "MAR-1" }, { signal });
      assert.equal(res.isError ?? false, false, `call #${i} should not error`);
    }

    // Call 4 must be rejected by the cap, BEFORE reaching the tool.
    const capped = await getIssue.handler({ issueId: "MAR-1" }, { signal });
    assert.equal(capped.isError, true);
    assert.match(capped.content[0]?.text ?? "", /tool_call_limit_exceeded/);
    assert.match(capped.content[0]?.text ?? "", /\[retryPolicy=abort\]/);
  });

  it("counts calls across different tools (not per-tool)", async () => {
    // The cap is a whole-run budget, not a per-tool one — an LLM that
    // alternates between two tools shouldn't be able to double its
    // budget. Regression test for that.
    const server = buildServer({
      client: stubClient(),
      scopedIssueId: null,
      maxToolCalls: 2,
    });
    const get = reachTool(server, "get_issue");
    const list = reachTool(server, "list_my_issues");
    const signal = new AbortController().signal;

    const r1 = await get.handler({ issueId: "MAR-1" }, { signal });
    const r2 = await list.handler({}, { signal });
    const r3 = await get.handler({ issueId: "MAR-1" }, { signal });

    assert.equal(r1.isError ?? false, false);
    assert.equal(r2.isError ?? false, false);
    assert.equal(r3.isError, true);
    assert.match(r3.content[0]?.text ?? "", /tool_call_limit_exceeded/);
  });
});

describe("buildServer — scope enforcement end-to-end", () => {
  it("binds PAPERCLIP_ISSUE_ID through to the tool's assertWriteScope", async () => {
    // End-to-end: we pass scopedIssueId="MAR-30" into buildServer. A
    // write to a different issue should come back as a ScopeViolation
    // errorResult, with no HTTP call made (the stub client's POST would
    // otherwise return {} which would look like success).
    const server = buildServer({
      client: stubClient(),
      scopedIssueId: "MAR-30",
    });
    const comment = reachTool(server, "post_issue_comment");
    const res = await comment.handler(
      { issueId: "MAR-99", body: "should fail" },
      { signal: new AbortController().signal },
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0]?.text ?? "", /scope violation/);
    assert.match(res.content[0]?.text ?? "", /\[retryPolicy=fix-args\]/);
  });

  it("allows writes to the bound issue", async () => {
    const server = buildServer({
      client: stubClient(),
      scopedIssueId: "MAR-30",
    });
    const comment = reachTool(server, "post_issue_comment");
    const res = await comment.handler(
      { issueId: "MAR-30", body: "on topic" },
      { signal: new AbortController().signal },
    );
    assert.equal(res.isError ?? false, false);
  });
});

// Keep the import so the type-check pass catches any drift in the SDK's
// zod peer-dep contract that could otherwise silently break tool schemas.
void z;
