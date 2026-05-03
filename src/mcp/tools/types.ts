import { z } from "zod";
import type { PaperclipClient } from "../client.js";

/**
 * A Paperclip MCP tool.
 *
 * We deliberately keep this tiny and independent of the MCP SDK's own
 * types so the tool registry stays testable in isolation — unit tests
 * can construct a fake client + stubbed zod schemas and exercise
 * {@link execute} without booting a stdio server.
 *
 * `inputSchema` is a plain object of zod schemas (NOT a wrapped
 * `z.object(...)`). McpServer.registerTool consumes this shape
 * directly and auto-derives the JSON schema the LLM sees.
 */
export interface ToolDef<I extends Record<string, z.ZodTypeAny>> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  execute: (args: z.infer<z.ZodObject<I>>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * ToolContext is passed to every tool invocation. It carries the
 * Paperclip client, structured logging, and the per-run scope guard.
 *
 * The scope guard is the security boundary: when the adapter launches
 * the MCP server for an adapter-assigned run, it sets
 * `PAPERCLIP_ISSUE_ID` in the env. The {@link assertWriteScope} helper
 * rejects write attempts against any other issue id. For heartbeat
 * runs `PAPERCLIP_ISSUE_ID` is unset, so writes to any issue are
 * allowed (the agent found the work itself).
 */
export interface ToolContext {
  client: PaperclipClient;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Throws a scope-violation error if `issueId` is provided,
   * `PAPERCLIP_ISSUE_ID` is set, and they don't match.
   * Reads are unaffected — only write operations should call this.
   */
  assertWriteScope: (issueId: string) => void;
}

export interface ToolResult {
  /**
   * Human-readable text payload the LLM reads. We return JSON-ish text
   * for structured data (LLMs parse it fine) to keep the transport
   * schema simple and model-agnostic.
   */
  text: string;
  /** Set true when the tool invocation failed; surfaces to the LLM as an error. */
  isError?: boolean;
  /**
   * Hint for the LLM on whether to retry. Only meaningful when `isError`.
   * - "retry": transient failure (5xx, network, rate limit). Try again.
   * - "fix-args": the call was malformed (400/422, scope violation). Don't repeat.
   * - "abort": non-recoverable (auth, not found). Escalate via RESULT marker.
   */
  retryPolicy?: "retry" | "fix-args" | "abort";
}

export class ScopeViolation extends Error {
  readonly issueId: string;
  readonly scope: string;
  constructor(issueId: string, scope: string) {
    super(
      `scope violation: this run is scoped to issue ${scope}, cannot write to ${issueId}`,
    );
    this.name = "ScopeViolation";
    this.issueId = issueId;
    this.scope = scope;
  }
}

export function okResult(payload: unknown): ToolResult {
  return { text: stringify(payload) };
}

/**
 * Leading anti-hallucination tag for tool errors, keyed by retryPolicy.
 *
 * Why: the 2026-05-03 LinkedIn Strategist run-4c6fc85b post-mortem found
 * that an agent receiving three consecutive `post_issue_interaction`
 * fix-args errors collapsed the failures into a hallucinated diagnosis
 * — "the MCP server appears unreachable" — even though every error
 * response carried `[retryPolicy=fix-args]` and a clear schema-rejection
 * message. The LLM's NLU pattern-matched on the bare word "error" and
 * cached the wrong frame for the rest of the run.
 *
 * The cure is a leading semantic tag that an LLM cannot misread:
 *   `fix-args` → MCP-server-is-healthy, args-are-wrong
 *   `retry`    → transient, momentary unavailability, just retry
 *   `abort`    → non-recoverable, do NOT keep retrying the same call
 *
 * The explicit "MCP server is healthy" anchor on `fix-args` is the
 * load-bearing phrase: it pre-empts the unreachable-server hallucination
 * by stating the contrary frame directly in the error body.
 *
 * Exported so the server.ts SDK-validation interception path uses the
 * same vocabulary as the in-tool error paths — no LLM should ever see
 * two error shapes for the same semantic class.
 */
export const ERROR_PREFIXES = {
  "fix-args":
    "[ARGS REJECTED — MCP server is healthy; your call arguments did not match the tool's schema. Read the message below, fix the offending field, and retry the same tool. Do NOT conclude the server is unreachable.]",
  retry:
    "[TRANSIENT FAILURE — the call reached the server but a downstream resource was momentarily unavailable. Wait briefly and retry the same call.]",
  abort:
    "[NON-RECOVERABLE — auth failure, missing record, or quota exhaustion. Do NOT retry the same call. Document the failure via post_issue_comment if appropriate, then call update_issue_status with status=blocked.]",
} as const;

export function errorResult(
  message: string,
  retryPolicy: NonNullable<ToolResult["retryPolicy"]> = "abort",
  details?: unknown,
): ToolResult {
  const prefix = ERROR_PREFIXES[retryPolicy];
  const body = `${message} [retryPolicy=${retryPolicy}]`;
  const text = details === undefined
    ? `${prefix}\n${body}`
    : `${prefix}\n${body}\n${stringify(details)}`;
  return { text, isError: true, retryPolicy };
}

/**
 * Map an HTTP status to a retry policy. Used by all tools so the LLM
 * gets consistent hints on how to respond to a failed call:
 *   4xx client errors → fix the args (don't loop with the same input).
 *   401/403 → auth problem, abort entirely (the adapter wires auth).
 *   404 → abort for this id (likely wrong id), fix-args for retry.
 *   429/5xx → retry (transient; server-side or rate limit).
 */
export function classifyHttp(status: number): ToolResult["retryPolicy"] {
  if (status === 401 || status === 403) return "abort";
  if (status === 404) return "fix-args";
  if (status === 429) return "retry";
  if (status >= 500) return "retry";
  if (status >= 400) return "fix-args";
  return "retry";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
