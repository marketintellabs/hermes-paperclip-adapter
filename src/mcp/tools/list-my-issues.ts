import { z } from "zod";
import { PaperclipClientError } from "../client.js";
import { classifyHttp, errorResult, okResult, type ToolDef } from "./types.js";

const inputSchema = {
  includeDone: z
    .boolean()
    .optional()
    .describe(
      "If true, includes issues in terminal states (done/cancelled). Default false — most of the time you want only actionable work.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of issues to return. Defaults to 50."),
};

/**
 * list_my_issues — return issues currently assigned to this agent.
 *
 * Replaces the curl-plus-python heartbeat gymnastic from mil-heartbeat-v2
 * (see templates/mil-heartbeat-v2.md, `{{noTask}}` branch). The tool
 * filters out terminal statuses by default and returns a compact JSON
 * list the LLM can reason over directly.
 */
export const listMyIssuesTool: ToolDef<typeof inputSchema> = {
  name: "list_my_issues",
  title: "List my issues",
  description:
    "Return issues assigned to the current agent. Use this at the start of a heartbeat wake, or any time you want to see your open work queue. Returns a JSON array of { id, identifier, title, status, priority, updatedAt }.",
  inputSchema,
  async execute({ includeDone, limit }, { client, log }) {
    const { agentId, companyId } = client.config;
    if (!agentId || !companyId) {
      return errorResult(
        "PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID must be set in the MCP server env. The adapter normally sets both — if you're seeing this, something upstream stripped them.",
        "abort",
      );
    }

    try {
      const issues = await client.get<RawIssue[]>(
        `/companies/${companyId}/issues`,
        { assigneeAgentId: agentId },
      );

      const filtered = (includeDone
        ? issues
        : issues.filter((i) => !TERMINAL.has(i.status)))
        .slice(0, limit ?? 50)
        .map((i) => ({
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          status: i.status,
          priority: i.priority,
          updatedAt: i.updatedAt,
        }));

      log("list_my_issues ok", { total: issues.length, returned: filtered.length });
      return okResult(filtered);
    } catch (err) {
      if (err instanceof PaperclipClientError) {
        return errorResult(
          `list_my_issues: Paperclip API error (${err.status}) ${err.message}`,
          classifyHttp(err.status),
          err.body,
        );
      }
      return errorResult(
        `list_my_issues: ${(err as Error)?.message ?? String(err)}`,
        "retry",
      );
    }
  },
};

const TERMINAL = new Set(["done", "cancelled"]);

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority?: number | string | null;
  updatedAt?: string;
}
