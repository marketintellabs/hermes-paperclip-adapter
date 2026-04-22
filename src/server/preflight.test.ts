/**
 * Tests for the pre-flight assigned-work check.
 *
 * Run with: `npm test`
 *
 * Uses the Node built-in test runner. Hits `preflightAssignedWork` with a
 * stub fetch implementation so there is no network or Paperclip dependency.
 *
 * Every assertion pairs a specific input shape with the exact
 * `PreflightDecision` shape the adapter will see. The golden rule is
 * **fail-open**: the only way to return `action: "skip"` is a 2xx JSON
 * response that unambiguously says "zero open issues assigned".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { preflightAssignedWork } from "./preflight.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function stubFetch(response: Response | Error): typeof fetch {
  return (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
}

const baseInput = {
  apiBase: "http://127.0.0.1:3100/api",
  apiKey: "pcp_test",
  agentId: "agent-1",
  companyId: "company-1",
};

describe("preflightAssignedWork — explicit work", () => {
  it("proceeds when a taskId is present (no HTTP call)", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "TRA-42",
      commentId: "",
      fetchImpl,
    });

    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "task_assigned");
    assert.equal(decision.openIssueCount, null);
    assert.equal(
      fetchCalled,
      false,
      "taskId short-circuit must not call the issues API",
    );
  });

  it("proceeds when a commentId is present (no HTTP call)", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "cmt-123",
      fetchImpl,
    });

    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "comment_event");
    assert.equal(fetchCalled, false);
  });
});

describe("preflightAssignedWork — fail-open on missing inputs", () => {
  it("proceeds with 'no_api_key' when apiKey is undefined", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      apiKey: undefined,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(jsonResponse([])),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "preflight_skipped_no_api_key");
  });

  it("proceeds with 'missing_ids' when agentId is undefined", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      agentId: undefined,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(jsonResponse([])),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "preflight_skipped_missing_ids");
  });

  it("proceeds with 'missing_ids' when companyId is undefined", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      companyId: undefined,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(jsonResponse([])),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "preflight_skipped_missing_ids");
  });
});

describe("preflightAssignedWork — network/HTTP errors fail open", () => {
  it("proceeds when fetch throws", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(new Error("ECONNREFUSED")),
    });
    assert.equal(decision.action, "proceed");
    assert.ok(decision.reason.startsWith("preflight_error_network:"));
  });

  it("proceeds when the API returns 500", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(new Response("boom", { status: 500 })),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "preflight_error_http:500");
  });

  it("proceeds when the API returns 401", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(new Response("unauth", { status: 401 })),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "preflight_error_http:401");
  });

  it("proceeds when the response body is not JSON", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });
    assert.equal(decision.action, "proceed");
    assert.ok(decision.reason.startsWith("preflight_error_parse:"));
  });

  it("proceeds when the response shape is unexpected", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(jsonResponse({ unexpected: "shape" })),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "preflight_error_unexpected_shape");
  });
});

describe("preflightAssignedWork — response parsing", () => {
  it("skips when the assigned list is empty", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(jsonResponse([])),
    });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "no_open_assigned_issues");
    assert.equal(decision.openIssueCount, 0);
  });

  it("skips when all assigned issues are done/cancelled", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(
        jsonResponse([
          { id: "a", status: "done" },
          { id: "b", status: "cancelled" },
          { id: "c", status: "done" },
        ]),
      ),
    });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "no_open_assigned_issues");
    assert.equal(decision.openIssueCount, 0);
  });

  it("proceeds when there is a single todo issue", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(
        jsonResponse([{ id: "a", status: "todo" }]),
      ),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "open_issues_found");
    assert.equal(decision.openIssueCount, 1);
  });

  it("counts only non-terminal issues", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(
        jsonResponse([
          { id: "a", status: "todo" },
          { id: "b", status: "in_progress" },
          { id: "c", status: "done" },
          { id: "d", status: "blocked" },
          { id: "e", status: "cancelled" },
          { id: "f", status: "in_review" },
          { id: "g", status: "backlog" },
        ]),
      ),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.reason, "open_issues_found");
    // todo + in_progress + blocked + in_review + backlog = 5
    assert.equal(decision.openIssueCount, 5);
  });

  it("accepts paginated { issues: [...] } envelope", async () => {
    const decision = await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl: stubFetch(
        jsonResponse({ issues: [{ id: "a", status: "todo" }] }),
      ),
    });
    assert.equal(decision.action, "proceed");
    assert.equal(decision.openIssueCount, 1);
  });
});

describe("preflightAssignedWork — request shape", () => {
  it("calls the expected URL with a Bearer auth header", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      const headers = (init.headers as Record<string, string>) ?? {};
      capturedAuth = headers.Authorization ?? "";
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await preflightAssignedWork({
      ...baseInput,
      taskId: "",
      commentId: "",
      fetchImpl,
    });

    assert.equal(
      capturedUrl,
      "http://127.0.0.1:3100/api/companies/company-1/issues?assigneeAgentId=agent-1",
    );
    assert.equal(capturedAuth, "Bearer pcp_test");
  });

  it("URL-encodes agent and company IDs", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await preflightAssignedWork({
      ...baseInput,
      companyId: "a/b",
      agentId: "c d",
      taskId: "",
      commentId: "",
      fetchImpl,
    });

    assert.ok(capturedUrl.includes("/companies/a%2Fb/issues"));
    assert.ok(capturedUrl.includes("assigneeAgentId=c%20d"));
  });
});
