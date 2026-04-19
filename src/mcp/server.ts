import { appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, type PaperclipClient } from "./client.js";
import { ALL_TOOLS } from "./tools/index.js";
import { ScopeViolation, type ToolContext } from "./tools/types.js";

const SERVER_NAME = "paperclip";
const SERVER_VERSION = "0.8.0-mil.0";

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

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  let callCount = 0;

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

  for (const tool of ALL_TOOLS) {
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
                  `tool_call_limit_exceeded: this run has already made ${maxCalls} tool calls. ` +
                  `Finish the work with the information you already have and emit your RESULT: marker. ` +
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
                text: `internal tool error: ${message} [retryPolicy=retry]`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
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
