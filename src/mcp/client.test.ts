/**
 * Regression tests for the MCP Paperclip client URL builder.
 *
 * Context: 0.7.0–0.7.2-mil.0 shipped with a broken `buildUrl`. It used
 * `new URL("/issues/X", "http://host/api")` which discards `/api` (absolute
 * paths resolve against origin, not against the base's pathname). Every
 * MCP tool call silently hit the SPA HTML instead of the JSON API.
 *
 * We do NOT want that to regress, so this test exercises the request path
 * end-to-end through `fetch` and asserts the actual URL the client tried
 * to open — including the `/api` prefix.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createClient, PaperclipClientError } from "./client.js";

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

function installFakeFetch(): {
  calls: CapturedRequest[];
  respond: (status: number, body: unknown) => void;
  restore: () => void;
} {
  const calls: CapturedRequest[] = [];
  let nextStatus = 200;
  let nextBody: unknown = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(typeof nextBody === "string" ? nextBody : JSON.stringify(nextBody), {
      status: nextStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    respond(status, body) {
      nextStatus = status;
      nextBody = body;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

describe("PaperclipClient buildUrl", () => {
  let fake: ReturnType<typeof installFakeFetch>;

  beforeEach(() => {
    fake = installFakeFetch();
  });

  afterEach(() => {
    fake.restore();
  });

  it("preserves the /api suffix on the base URL when path is absolute", async () => {
    fake.respond(200, { id: "MAR-29" });
    const client = createClient({
      apiUrl: "http://paperclip:3100/api",
      apiKey: "test",
      agentId: null,
      companyId: null,
    });

    await client.get("/issues/MAR-29");

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.url, "http://paperclip:3100/api/issues/MAR-29");
  });

  it("preserves multi-segment base paths", async () => {
    fake.respond(200, []);
    const client = createClient({
      apiUrl: "http://host/api/v2",
      apiKey: "test",
      agentId: null,
      companyId: null,
    });

    await client.get("/issues/MAR-1/comments");

    assert.equal(
      fake.calls[0]!.url,
      "http://host/api/v2/issues/MAR-1/comments",
    );
  });

  it("tolerates a trailing slash on the base URL", async () => {
    fake.respond(200, {});
    const client = createClient({
      apiUrl: "http://host/api/",
      apiKey: "test",
      agentId: null,
      companyId: null,
    });

    await client.get("/issues/MAR-1");

    assert.equal(fake.calls[0]!.url, "http://host/api/issues/MAR-1");
  });

  it("prepends a leading slash when path is relative", async () => {
    fake.respond(200, {});
    const client = createClient({
      apiUrl: "http://host/api",
      apiKey: "test",
      agentId: null,
      companyId: null,
    });

    await client.get("issues/MAR-1");

    assert.equal(fake.calls[0]!.url, "http://host/api/issues/MAR-1");
  });

  it("appends query params correctly with the /api prefix", async () => {
    fake.respond(200, []);
    const client = createClient({
      apiUrl: "http://host/api",
      apiKey: "test",
      agentId: null,
      companyId: null,
    });

    await client.get("/issues", { assigneeId: "abc", limit: 5 });

    assert.equal(
      fake.calls[0]!.url,
      "http://host/api/issues?assigneeId=abc&limit=5",
    );
  });

  it("sends POST body and Authorization header through the same resolved URL", async () => {
    fake.respond(200, { id: "c1" });
    const client = createClient({
      apiUrl: "http://host/api",
      apiKey: "key-xyz",
      agentId: null,
      companyId: null,
    });

    await client.post("/issues/MAR-29/comments", { body: "hello" });

    assert.equal(fake.calls[0]!.url, "http://host/api/issues/MAR-29/comments");
    assert.equal(fake.calls[0]!.method, "POST");
    assert.equal(fake.calls[0]!.body, JSON.stringify({ body: "hello" }));
  });

  it("throws PaperclipClientError with the path (not full URL) on non-2xx", async () => {
    fake.respond(404, { error: "not found" });
    const client = createClient({
      apiUrl: "http://host/api",
      apiKey: "k",
      agentId: null,
      companyId: null,
    });

    await assert.rejects(
      () => client.get("/issues/bogus"),
      (err: unknown) => {
        assert.ok(err instanceof PaperclipClientError);
        assert.equal((err as PaperclipClientError).status, 404);
        assert.equal((err as PaperclipClientError).path, "/issues/bogus");
        return true;
      },
    );
  });
});
