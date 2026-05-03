import { appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClient, type PaperclipClient } from "./client.js";
import { ALL_TOOLS } from "./tools/index.js";
import { ERROR_PREFIXES, ScopeViolation, type ToolContext } from "./tools/types.js";
import { ADAPTER_VERSION } from "../shared/version.js";

const SERVER_NAME = "paperclip";
// Re-exported as `SERVER_VERSION` for backwards compatibility with
// existing imports; canonical source is `shared/version.ts`.
export const SERVER_VERSION = ADAPTER_VERSION;

/**
 * Hard cap on tool calls per run, enforced inside the MCP server
 * process so Hermes cannot bypass it. This is defense in depth on top
 * of Hermes' own --max-turns: one turn can emit multiple tool calls,
 * so a turn cap alone doesn't bound the tool-call explosion.
 *
 * 20 is chosen empirically: a well-behaved agent should hit <5 in a
 * typical run (list_my_issues, get_issue, a progress comment, maybe
 * a sub-issue). Hitting the cap is a strong signal the LLM is looping.
 */
const MAX_TOOL_CALLS = 20;

export interface BuildOptions {
  client?: PaperclipClient;
  /**
   * Override for the issue-scope env var. Tests set this to avoid
   * mutating process.env; production reads from env only.
   */
  scopedIssueId?: string | null;
  /**
   * Override for MAX_TOOL_CALLS. Tests use this to exercise the cap
   * without spamming 20 real calls.
   */
  maxToolCalls?: number;
  /**
   * Path to an NDJSON audit file to append per-call records to
   * (`tool_call_end` / `tool_call_error`). The adapter sets this per
   * run via `PAPERCLIP_MCP_AUDIT_LOG` env so execute.ts can surface
   * tool-call telemetry into run.resultJson.toolCalls without the LLM
   * having any say in the matter.
   *
   * When null/undefined, audit logging is disabled and we only emit
   * the stderr log line (same as 0.7.x behaviour).
   */
  auditLogPath?: string | null;
  /**
   * Per-agent tool allowlist. When provided (typically from the
   * PAPERCLIP_MCP_TOOLS env var baked into the per-run config.yaml by
   * the adapter), only tools whose `name` appears in this list are
   * registered. When null/undefined, every tool in `ALL_TOOLS` is
   * registered (backward compatible).
   *
   * Rationale: agents that don't need to decompose work (individual
   * publishers, research analysts, etc.) get a read-only-ish set —
   * `list_my_issues`, `get_issue`, `post_issue_comment`,
   * `update_issue_status`. Heads and the CEO keep `create_sub_issue`
   * so they can delegate within their assigned tree. See
   * paperclip/company-template.json for the canonical allowlist per
   * agent.
   *
   * Names not found in `ALL_TOOLS` are logged and skipped (not an
   * error; tolerates renames / template drift).
   */
  allowedTools?: readonly string[] | null;
}

/**
 * Parse a comma-separated `PAPERCLIP_MCP_TOOLS` env value into a clean
 * allowlist.
 *
 *   unset / null      → null  ("no allowlist configured, register all")
 *   empty / blank     → []    ("explicit deny-all, register none")
 *   "a,b,c"           → ["a", "b", "c"]
 *
 * Distinguishing these three is important: `process.env.FOO` is
 * `undefined` when unset but `""` when explicitly set to empty, and
 * `buildMcpServerSpec` relies on that to propagate a deny-all config
 * through to the subprocess without falling back to register-all.
 *
 * Exported for unit tests.
 */
export function parseAllowedToolsEnv(raw: string | undefined | null): readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Filter {@link ALL_TOOLS} against a per-agent allowlist. When the
 * allowlist is null/undefined we register everything (backward
 * compatible default). When it's empty-after-parsing we register
 * nothing but still boot the server — the LLM will get "tool not
 * registered" errors on any call, which is the explicit intent of an
 * operator who wrote `paperclipMcpTools: []`.
 *
 * Unknown names are logged to stderr and skipped. A typo in the
 * company template shouldn't prevent a department container from
 * booting.
 *
 * Exported for unit tests.
 */
export function resolveToolsToRegister(
  allowed: readonly string[] | null | undefined,
): typeof ALL_TOOLS[number][] {
  if (!allowed) return [...ALL_TOOLS];
  const allowedSet = new Set(allowed);
  const known = new Set(ALL_TOOLS.map((t) => t.name));
  const unknownNames = [...allowedSet].filter((n) => !known.has(n));
  if (unknownNames.length > 0) {
    process.stderr.write(
      `[paperclip-mcp] allowlist names not recognized (will be ignored): ${unknownNames.join(", ")}\n`,
    );
  }
  return ALL_TOOLS.filter((t) => allowedSet.has(t.name));
}

/**
 * Build a configured McpServer with the Paperclip toolset registered.
 *
 * Split out from {@link runStdioServer} so tests can construct the
 * server without touching stdin/stdout, and so future transports
 * (http, sse) can reuse the same tool registration.
 */
export function buildServer(opts: BuildOptions = {}): McpServer {
  const client = opts.client ?? createClient();
  const scopedIssueId =
    opts.scopedIssueId !== undefined
      ? opts.scopedIssueId
      : (process.env.PAPERCLIP_ISSUE_ID ?? null);
  const maxCalls = opts.maxToolCalls ?? MAX_TOOL_CALLS;
  const auditLogPath =
    opts.auditLogPath !== undefined
      ? opts.auditLogPath
      : (process.env.PAPERCLIP_MCP_AUDIT_LOG ?? null);
  const allowedTools =
    opts.allowedTools !== undefined
      ? opts.allowedTools
      : parseAllowedToolsEnv(process.env.PAPERCLIP_MCP_TOOLS);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  let callCount = 0;

  // Resolve which tools to register. When the agent has an allowlist,
  // filter ALL_TOOLS to only those entries — unknown names log and skip
  // so a typo in the template doesn't take the whole MCP server down.
  const toolsToRegister = resolveToolsToRegister(allowedTools);

  const writeLog = (event: string, meta: Record<string, unknown>) => {
    const record = {
      t: new Date().toISOString(),
      source: "paperclip-mcp",
      event,
      ...meta,
    };
    const line = JSON.stringify(record);
    process.stderr.write(`[paperclip-mcp-log] ${line}\n`);

    // Append to audit log for adapter-side collection. We only log
    // events that represent a completed call — the start event is
    // noise in the audit trail, though it stays in stderr for live
    // debugging. Errors are logged too (as a distinct event) so the
    // adapter can count failures without parsing the ok flag.
    if (auditLogPath && (event === "tool_call_end" || event === "tool_call_error")) {
      try {
        appendFileSync(auditLogPath, `${line}\n`);
      } catch (err) {
        // Audit log failures must NEVER break a tool call. The file
        // might be on a filesystem that's temporarily full, or the
        // adapter might have cleaned up HERMES_HOME mid-run. Degrade
        // to stderr-only — execute.ts will just see missing records.
        process.stderr.write(
          `[paperclip-mcp] audit log write failed (non-fatal): ${
            (err as Error).message
          }\n`,
        );
      }
    }
  };

  const toolCtx: ToolContext = {
    client,
    log: (msg, meta) => {
      writeLog(msg, meta ?? {});
    },
    assertWriteScope: (issueId: string) => {
      if (!scopedIssueId) return; // Heartbeat runs: no scope, writes open.
      if (issueId === scopedIssueId) return;
      throw new ScopeViolation(issueId, scopedIssueId);
    },
  };

  for (const tool of toolsToRegister) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        callCount += 1;
        const callId = callCount;
        const start = Date.now();

        writeLog("tool_call_start", { callId, tool: tool.name, args });

        if (callCount > maxCalls) {
          writeLog("tool_call_limit_exceeded", { callId, tool: tool.name, maxCalls });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${ERROR_PREFIXES.abort}\n` +
                  `tool_call_limit_exceeded: this run has already made ${maxCalls} tool calls. ` +
                  `Finish the work with the information you already have and call update_issue_status to terminate. ` +
                  `[retryPolicy=abort]`,
              },
            ],
            isError: true,
          };
        }

        try {
          const result = await tool.execute(args as never, toolCtx);
          writeLog("tool_call_end", {
            callId,
            tool: tool.name,
            ok: !result.isError,
            retryPolicy: result.retryPolicy ?? null,
            durationMs: Date.now() - start,
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            isError: result.isError ?? false,
          };
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          writeLog("tool_call_error", {
            callId,
            tool: tool.name,
            error: message,
            durationMs: Date.now() - start,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${ERROR_PREFIXES.retry}\n` +
                  `internal tool error: ${message} [retryPolicy=retry]`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  // SDK-validation interception. Background:
  //
  // The upstream MCP SDK installs its own `tools/call` request handler
  // when registerTool runs (see node_modules/@modelcontextprotocol/sdk
  // /dist/esm/server/mcp.js §setToolRequestHandlers). That handler
  // calls validateToolInput → safeParseAsync against the tool's
  // inputSchema BEFORE invoking our per-tool execute() callback. When
  // validation fails, the SDK throws `McpError(InvalidParams, "Input
  // validation error: Invalid arguments for tool X: ...")` and converts
  // it via createToolError into a CallToolResult with text equal to
  // the raw error message — no `[retryPolicy=...]` tag, no `[ARGS
  // REJECTED ...]` prefix, nothing the LLM can use to disambiguate
  // a schema-rejection from a network failure.
  //
  // The 2026-05-03 LinkedIn Strategist (run 4c6fc85b) post-mortem found
  // that this exact gap caused an agent to hallucinate "MCP server
  // appears unreachable" after three consecutive args-validation
  // rejections on `post_issue_interaction`. The server was healthy;
  // the LLM just couldn't see that from the bare error text.
  //
  // Fix: re-set the `tools/call` handler AFTER registerTool has
  // installed the SDK's auto-handler. setRequestHandler does a Map.set
  // (per shared/protocol.js §setRequestHandler), so this cleanly
  // replaces the previous handler. We delegate to the SDK-installed
  // handler for the actual work, then post-process its return value
  // to detect the validation-error shape and reformat with our
  // standard prefix vocabulary. Successful tool calls and tool-emitted
  // errorResult() responses pass through unchanged.
  //
  // Why post-process the SDK's return rather than re-implementing the
  // whole call flow: the SDK owns task-support routing, output-schema
  // validation, capability checks, and the disabled-tool path. We want
  // our hands off all of that. The validation-error shape is stable
  // (`isError: true`, single text content beginning with "Input
  // validation error:" or "Invalid arguments for tool"), so detection
  // is reliable.
  installValidationErrorReformatter(server, writeLog);

  return server;
}

/**
 * Pattern that identifies a CallToolResult emitted by the SDK's
 * built-in `validateToolInput` failure path.
 *
 * Observed SDK shapes (across versions):
 *   "Invalid arguments for tool X: <zod path>"
 *   "Input validation error: Invalid arguments for tool X: <zod path>"
 *   "MCP error -32602: Input validation error: Invalid arguments for tool X: <zod path>"
 *
 * The McpError class formats `.message` as `MCP error <code>: <text>`,
 * and the SDK forwards that verbatim into createToolError. So the
 * outermost prefix is always `MCP error -32602:` (InvalidParams = -32602
 * per JSON-RPC 2.0). Detection is permissive: we look for "Invalid
 * arguments for tool" anywhere in the text and capture the tool name
 * + zod detail. The `s` flag makes `.` cross newlines (zod errors are
 * multi-line JSON when multiple fields fail).
 */
const SDK_VALIDATION_ERROR_PATTERN =
  /Invalid arguments for tool ([^:]+):\s*(.*)/s;

/**
 * Replace the SDK-installed `tools/call` handler with a thin wrapper
 * that delegates to the original and reformats validation errors so
 * the LLM sees the same `[ARGS REJECTED — MCP server is healthy; ...]`
 * prefix that in-tool errorResult() emits. Idempotent across SDK
 * versions; if the SDK's error shape ever changes, the regex misses,
 * the response passes through unchanged, and the worst case is we
 * regress to the pre-0.9.3 untagged shape (which is what the LLM gets
 * today on every other adapter version).
 */
function installValidationErrorReformatter(
  server: McpServer,
  writeLog: (event: string, meta: Record<string, unknown>) => void,
): void {
  // McpServer wraps a low-level Server as `.server`; that's where the
  // CallToolRequestSchema handler lives. Both classes are public API
  // (per the SDK docs), so this is supported usage rather than
  // private-internals access.
  const lowLevel = server.server;
  const sdkHandler = lowLevel["_requestHandlers"].get("tools/call");
  if (!sdkHandler) {
    process.stderr.write(
      "[paperclip-mcp] WARN: SDK tools/call handler not found; validation-error reformatter not installed\n",
    );
    return;
  }

  lowLevel.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await sdkHandler(request, extra);

    // Successful results, or non-text errors, pass through.
    if (!result || typeof result !== "object") return result;
    const r = result as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (!r.isError || !r.content || r.content.length === 0) return result;
    const first = r.content[0];
    if (first?.type !== "text" || typeof first.text !== "string") return result;

    // Already prefixed (in-tool errorResult or our own limit-exceeded
    // path) — don't double-wrap.
    if (
      first.text.startsWith(ERROR_PREFIXES["fix-args"]) ||
      first.text.startsWith(ERROR_PREFIXES.retry) ||
      first.text.startsWith(ERROR_PREFIXES.abort)
    ) {
      return result;
    }

    const match = SDK_VALIDATION_ERROR_PATTERN.exec(first.text);
    if (!match) return result;

    const [, toolName, detail] = match;
    writeLog("tool_call_validation_rejected", {
      tool: toolName,
      detail: detail.slice(0, 240),
    });

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            `${ERROR_PREFIXES["fix-args"]}\n` +
            `${toolName}: SDK schema validation rejected your arguments. ${detail.trim()} ` +
            `[retryPolicy=fix-args]`,
        },
      ],
    };
  });
}

/**
 * Install a liveness file that proves to the adapter the MCP server
 * actually booted and is still running at process exit.
 *
 * Design: at startup we write `{pid, startedAt, version}` to the file.
 * On clean shutdown we delete it. The adapter then checks post-run:
 *
 *   file missing       → MCP exited cleanly
 *   file exists + pid is alive → MCP still running (Hermes killed the transport)
 *   file exists + pid is dead  → MCP DIED mid-run → errorCode tool_server_died
 *
 * We catch SIGTERM, SIGINT, and `beforeExit` so normal termination
 * paths remove the file. Crashes (OOM, uncaughtException, SIGKILL)
 * leave the file behind on purpose — that's the signal.
 */
function installLivenessFile(path: string): void {
  try {
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: SERVER_VERSION,
      }),
      { mode: 0o600 },
    );
  } catch (err) {
    process.stderr.write(
      `[paperclip-mcp] liveness file write failed (non-fatal): ${
        (err as Error).message
      }\n`,
    );
    return;
  }

  const removeLiveness = () => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or readonly fs — either way, nothing to do.
    }
  };

  process.on("beforeExit", removeLiveness);
  process.on("SIGTERM", () => {
    removeLiveness();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    removeLiveness();
    process.exit(0);
  });
}

/**
 * Boot the stdio MCP server. This is the shape Hermes launches via
 *
 *   mcp_servers:
 *     paperclip:
 *       command: node
 *       args: [".../dist/mcp/cli.js"]
 *       env: { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_ISSUE_ID,
 *              PAPERCLIP_MCP_AUDIT_LOG, PAPERCLIP_MCP_LIVENESS_FILE, ... }
 *
 * in ~/.hermes/config.yaml. All logging goes to stderr because stdout
 * is the MCP transport channel.
 */
export async function runStdioServer(): Promise<void> {
  const livenessFile = process.env.PAPERCLIP_MCP_LIVENESS_FILE;
  if (livenessFile) {
    installLivenessFile(livenessFile);
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[paperclip-mcp] server ${SERVER_NAME}@${SERVER_VERSION} connected ` +
      `(${ALL_TOOLS.length} tools, maxCalls=${MAX_TOOL_CALLS}, ` +
      `scoped=${!!process.env.PAPERCLIP_ISSUE_ID}, ` +
      `audit=${!!process.env.PAPERCLIP_MCP_AUDIT_LOG}, ` +
      `liveness=${!!livenessFile})\n`,
  );
}
