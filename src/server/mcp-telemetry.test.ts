/**
 * Tests for the post-run MCP telemetry collector.
 *
 * These exercise the parser + health-check contracts that execute.ts
 * depends on. We use a real temp dir for fixture files so the
 * ENOENT-vs-missing-file distinction is exercised end-to-end.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkMcpServerHealth,
  collectMcpTelemetry,
  readToolCallAudit,
} from "./mcp-telemetry.js";

describe("readToolCallAudit", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-telemetry-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when file doesn't exist", async () => {
    const out = await readToolCallAudit(join(dir, "missing.ndjson"));
    assert.deepEqual(out, []);
  });

  it("returns [] when file is empty", async () => {
    const p = join(dir, "audit.ndjson");
    await writeFile(p, "");
    assert.deepEqual(await readToolCallAudit(p), []);
  });

  it("parses tool_call_end records", async () => {
    const p = join(dir, "audit.ndjson");
    const line = JSON.stringify({
      t: "2026-04-19T19:00:00Z",
      source: "paperclip-mcp",
      event: "tool_call_end",
      callId: 1,
      tool: "list_my_issues",
      ok: true,
      retryPolicy: null,
      durationMs: 42,
    });
    await writeFile(p, `${line}\n`);

    const records = await readToolCallAudit(p);
    assert.equal(records.length, 1);
    assert.equal(records[0].name, "list_my_issues");
    assert.equal(records[0].ok, true);
    assert.equal(records[0].callId, 1);
    assert.equal(records[0].durationMs, 42);
    assert.equal(records[0].retryPolicy, null);
  });

  it("parses tool_call_error records with ok=false", async () => {
    const p = join(dir, "audit.ndjson");
    const line = JSON.stringify({
      t: "2026-04-19T19:00:01Z",
      source: "paperclip-mcp",
      event: "tool_call_error",
      callId: 2,
      tool: "post_issue_comment",
      error: "boom",
      durationMs: 15,
    });
    await writeFile(p, `${line}\n`);
    const records = await readToolCallAudit(p);
    assert.equal(records.length, 1);
    assert.equal(records[0].ok, false);
    assert.equal(records[0].error, "boom");
  });

  it("ignores tool_call_start and other noise events", async () => {
    const p = join(dir, "audit.ndjson");
    const lines = [
      { event: "tool_call_start", callId: 1, tool: "x" },
      { event: "tool_call_end", callId: 1, tool: "x", ok: true, durationMs: 5 },
      { event: "tool_call_limit_exceeded", callId: 20, tool: "x" },
      { event: "some_unrelated_event", foo: "bar" },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    await writeFile(p, lines);
    const records = await readToolCallAudit(p);
    assert.equal(records.length, 1);
    assert.equal(records[0].callId, 1);
  });

  it("tolerates malformed lines — skips them, does not throw", async () => {
    const p = join(dir, "audit.ndjson");
    const good = JSON.stringify({
      event: "tool_call_end",
      callId: 1,
      tool: "get_issue",
      ok: true,
      durationMs: 10,
    });
    await writeFile(p, `{not json\n${good}\nalso garbage}\n`);
    const records = await readToolCallAudit(p);
    assert.equal(records.length, 1);
    assert.equal(records[0].callId, 1);
  });

  it("sorts records by callId (defensive against out-of-order flushes)", async () => {
    const p = join(dir, "audit.ndjson");
    const lines = [3, 1, 2]
      .map((id) =>
        JSON.stringify({
          event: "tool_call_end",
          callId: id,
          tool: "x",
          ok: true,
          durationMs: 1,
        }),
      )
      .join("\n");
    await writeFile(p, lines);
    const records = await readToolCallAudit(p);
    assert.deepEqual(
      records.map((r) => r.callId),
      [1, 2, 3],
    );
  });
});

describe("checkMcpServerHealth", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-health-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("missing file + no calls seen → never_booted", async () => {
    const h = await checkMcpServerHealth(join(dir, "nope.json"), false);
    assert.equal(h.status, "never_booted");
  });

  it("missing file + calls seen → healthy (clean shutdown)", async () => {
    const h = await checkMcpServerHealth(join(dir, "nope.json"), true);
    assert.equal(h.status, "healthy");
  });

  it("file present + pid is current process → still_running", async () => {
    const p = join(dir, "alive.json");
    await writeFile(
      p,
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-04-19T00:00:00Z",
        version: "test",
      }),
    );
    const h = await checkMcpServerHealth(p, true);
    assert.equal(h.status, "still_running");
    if (h.status === "still_running") assert.equal(h.pid, process.pid);
  });

  it("file present + pid is dead (pid=1 inside an unprivileged sandbox is usually alive; we use a pid we know is gone) → died", async () => {
    const p = join(dir, "dead.json");
    // Use an absurdly high pid that cannot exist — kernel pids cap
    // at 2^22 on Linux, so anything beyond that is definitely absent.
    // process.kill(2^28, 0) will throw ESRCH, which is what we want.
    const fakePid = 0x0fffffff;
    await writeFile(
      p,
      JSON.stringify({
        pid: fakePid,
        startedAt: "2026-04-19T00:00:00Z",
        version: "test",
      }),
    );
    const h = await checkMcpServerHealth(p, true);
    assert.equal(h.status, "died");
    if (h.status === "died") assert.equal(h.pid, fakePid);
  });

  it("file present but unparseable → died (corrupt liveness is itself a crash signal)", async () => {
    const p = join(dir, "corrupt.json");
    await writeFile(p, "{not valid json");
    const h = await checkMcpServerHealth(p, true);
    assert.equal(h.status, "died");
  });
});

describe("collectMcpTelemetry (integration)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-collect-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("happy path: calls written, liveness removed → healthy + records", async () => {
    const audit = join(dir, "calls.ndjson");
    const liveness = join(dir, "alive.json"); // intentionally absent
    await writeFile(
      audit,
      [
        { event: "tool_call_end", callId: 1, tool: "list_my_issues", ok: true, durationMs: 50 },
        { event: "tool_call_end", callId: 2, tool: "post_issue_comment", ok: true, durationMs: 120 },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n"),
    );
    const t = await collectMcpTelemetry(audit, liveness);
    assert.equal(t.toolCallCount, 2);
    assert.equal(t.toolErrorCount, 0);
    assert.equal(t.health.status, "healthy");
    assert.equal(t.toolCalls[0].name, "list_my_issues");
    assert.equal(t.toolCalls[1].name, "post_issue_comment");
  });

  it("counts tool errors separately from total", async () => {
    const audit = join(dir, "calls.ndjson");
    const liveness = join(dir, "alive.json");
    await writeFile(
      audit,
      [
        { event: "tool_call_end", callId: 1, tool: "get_issue", ok: true, durationMs: 5 },
        { event: "tool_call_end", callId: 2, tool: "get_issue", ok: false, durationMs: 8, retryPolicy: "fix-args" },
        { event: "tool_call_error", callId: 3, tool: "get_issue", error: "boom", durationMs: 2 },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n"),
    );
    const t = await collectMcpTelemetry(audit, liveness);
    assert.equal(t.toolCallCount, 3);
    assert.equal(t.toolErrorCount, 2);
  });

  it("no audit file + no liveness file → empty + never_booted", async () => {
    const t = await collectMcpTelemetry(
      join(dir, "calls.ndjson"),
      join(dir, "alive.json"),
    );
    assert.equal(t.toolCallCount, 0);
    assert.equal(t.health.status, "never_booted");
  });

  it("calls logged but liveness file still present with dead pid → died", async () => {
    const audit = join(dir, "calls.ndjson");
    const liveness = join(dir, "alive.json");
    await writeFile(
      audit,
      JSON.stringify({ event: "tool_call_end", callId: 1, tool: "x", ok: true, durationMs: 1 }),
    );
    await writeFile(
      liveness,
      JSON.stringify({ pid: 0x0fffffff, startedAt: "2026-04-19T00:00:00Z", version: "t" }),
    );
    const t = await collectMcpTelemetry(audit, liveness);
    assert.equal(t.toolCallCount, 1);
    assert.equal(t.health.status, "died");
  });
});
