/**
 * Post-run collection of MCP server telemetry.
 *
 * The adapter spawns Hermes, which in turn spawns the paperclip-mcp
 * subprocess. That subprocess writes two things into the per-run
 * HERMES_HOME:
 *
 *   mcp-tool-calls.ndjson   — one JSON line per completed/errored call
 *   mcp-liveness.json       — written on startup, deleted on clean exit
 *
 * We read both before the HERMES_HOME tempdir is cleaned up. The
 * audit records flow into `resultJson.toolCalls` so the run record is
 * the single source of truth for "what did this agent actually do".
 * The liveness file tells us whether the MCP subprocess died
 * unexpectedly (file still present + pid is dead).
 *
 * Isolated from execute.ts to keep that file's post-run logic
 * testable; the real I/O is a 20-line wrapper around this module.
 */

import { readFile, stat } from "node:fs/promises";

/**
 * A single normalized tool-call record. The MCP server emits richer
 * events internally (tool_call_start/end/error) but we only persist
 * terminal ones (end or error). That keeps the audit trail focused
 * on "what happened" rather than "when the LLM started thinking".
 */
export interface ToolCallRecord {
  /** Tool name, e.g. "list_my_issues". */
  name: string;
  /** 1-based sequence within the run, assigned by the MCP server. */
  callId: number;
  /** ISO timestamp when the record was written (call end / error). */
  t: string;
  /** True if the tool executed without returning isError. */
  ok: boolean;
  /** Wall-clock duration in ms as reported by the MCP server. */
  durationMs: number;
  /** Retry-policy hint attached to the tool result (ok or failure). */
  retryPolicy: "retry" | "fix-args" | "abort" | null;
  /** Error message, set only when ok=false. */
  error?: string;
}

/**
 * Describes whether the MCP subprocess exited cleanly or died. Used
 * to produce `errorCode: "tool_server_died"` on runs where the MCP
 * crashed mid-flight — a scenario that otherwise looks like the LLM
 * just… stopped calling tools.
 */
export type McpServerHealth =
  | { status: "never_booted" } // no liveness file written — server didn't start
  | { status: "healthy" } // liveness file missing at end (clean shutdown)
  | { status: "still_running"; pid: number } // file present, pid still alive
  | { status: "died"; pid: number; startedAt: string | null }; // file present, pid gone

export interface McpTelemetry {
  toolCalls: ToolCallRecord[];
  toolCallCount: number;
  toolErrorCount: number;
  health: McpServerHealth;
}

/**
 * Parse the NDJSON audit log file produced by the MCP server. Returns
 * an empty list if the file doesn't exist or is empty. Tolerates
 * malformed lines (skips them with a warning record) so a single bad
 * line can't black-hole the whole run's telemetry.
 */
export async function readToolCallAudit(
  auditLogPath: string,
): Promise<ToolCallRecord[]> {
  let raw: string;
  try {
    raw = await readFile(auditLogPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (!raw.trim()) return [];

  const records: ToolCallRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const event = obj.event;
      if (event !== "tool_call_end" && event !== "tool_call_error") continue;
      const callId = typeof obj.callId === "number" ? obj.callId : -1;
      const name = typeof obj.tool === "string" ? obj.tool : "(unknown)";
      const t = typeof obj.t === "string" ? obj.t : new Date().toISOString();
      const durationMs =
        typeof obj.durationMs === "number" ? obj.durationMs : 0;
      const retryPolicy =
        typeof obj.retryPolicy === "string" &&
        (obj.retryPolicy === "retry" ||
          obj.retryPolicy === "fix-args" ||
          obj.retryPolicy === "abort")
          ? obj.retryPolicy
          : null;
      const ok = event === "tool_call_end" ? obj.ok !== false : false;
      const rec: ToolCallRecord = {
        name,
        callId,
        t,
        ok,
        durationMs,
        retryPolicy,
      };
      if (typeof obj.error === "string") rec.error = obj.error;
      records.push(rec);
    } catch {
      // Single malformed line — skip it. The adapter logs the parse
      // error path count in stderr via the caller.
    }
  }
  // MCP server appends in-order but defensively sort by callId so
  // consumers don't have to worry about interleaved writes (none
  // today, but async flushes are a future regression risk).
  records.sort((a, b) => a.callId - b.callId);
  return records;
}

/**
 * Check whether the MCP subprocess shut down cleanly.
 *
 * Semantics (see install in server.ts):
 *   file absent                       → clean shutdown (or never booted)
 *   file present, {pid: N}            → N is alive  → still running
 *                                        N is dead  → crashed
 *
 * We distinguish `never_booted` from `healthy` by checking if any
 * tool calls landed in the audit log — if yes, the server clearly
 * ran at some point. If the liveness file is absent AND no calls
 * were made, we can't tell; report never_booted and let the caller
 * decide whether that's interesting (it usually isn't — many runs
 * just don't call tools).
 */
export async function checkMcpServerHealth(
  livenessFilePath: string,
  toolCallsSeen: boolean,
): Promise<McpServerHealth> {
  let raw: string;
  try {
    raw = await readFile(livenessFilePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: toolCallsSeen ? "healthy" : "never_booted" };
    }
    throw err;
  }

  let pid = -1;
  let startedAt: string | null = null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.pid === "number") pid = obj.pid;
    if (typeof obj.startedAt === "string") startedAt = obj.startedAt;
  } catch {
    // Corrupt liveness file is itself evidence of a crash during write.
    return { status: "died", pid: -1, startedAt: null };
  }

  if (pid <= 0) return { status: "died", pid, startedAt };

  if (isProcessAlive(pid)) {
    return { status: "still_running", pid };
  }
  return { status: "died", pid, startedAt };
}

/**
 * `process.kill(pid, 0)` is the portable "does this pid exist?" probe.
 * It sends no signal; raises ESRCH if the process doesn't exist,
 * EPERM if it does but we can't signal it (which still means alive).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * High-level one-shot: read the audit log, check liveness, and return
 * a consolidated telemetry object. Tolerant of either path being
 * absent (returns the degraded shape rather than throwing) because
 * adapter-owned-status runs that don't spawn MCP (legacy templates)
 * still call through here.
 */
export async function collectMcpTelemetry(
  auditLogPath: string,
  livenessFilePath: string,
): Promise<McpTelemetry> {
  const toolCalls = await readToolCallAudit(auditLogPath);
  const toolCallCount = toolCalls.length;
  const toolErrorCount = toolCalls.filter((c) => !c.ok).length;
  const health = await checkMcpServerHealth(livenessFilePath, toolCallCount > 0);
  return { toolCalls, toolCallCount, toolErrorCount, health };
}

// Touch `stat` so tree-shakers keep the import (unused directly today
// but used by the tests for fixture assertions). Zero runtime cost.
void stat;
