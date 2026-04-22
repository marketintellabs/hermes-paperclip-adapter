import { z } from "zod";
import { PaperclipClientError } from "../client.js";
import {
  classifyHttp,
  errorResult,
  okResult,
  ScopeViolation,
  type ToolDef,
} from "./types.js";

const inputSchema = {
  title: z.string().min(3).max(300).describe("Short title (3–300 chars)."),
  description: z
    .string()
    .min(1)
    .describe("Full markdown description with acceptance criteria and context the assignee needs."),
  assigneeAgentId: z
    .string()
    .describe("UUID of the agent to assign this issue to. Required — don't create unassigned work."),
  parentIssueId: z
    .string()
    .describe(
      "REQUIRED. The parent issue this sub-task is a child of. Agents cannot create top-level (un-parented) work via MCP — that comes from the board via Routines or manual assignment. On adapter-assigned runs parentIssueId MUST equal the issue you're currently working on.",
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe("0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low."),
};

/**
 * create_sub_issue — delegate work by creating a scoped sub-issue.
 *
 * Scope invariant (structural, not behavioural): `parentIssueId` is
 * REQUIRED and always scope-checked. On adapter-assigned runs the
 * parent must equal the caller's own issue, so every sub-issue traces
 * back to a board-originated root (a Routine firing, a manual
 * assignment). Agents cannot conjure top-level work through MCP.
 *
 * This closes the 2026-04-04 "CEO fabricates 49 investigations" regression:
 * even if an LLM system prompt drifts into inventing new mandates, the
 * MCP layer refuses them. Top-level issue creation is the board's
 * responsibility — via Routines (scheduled), manual assignment, or the
 * Paperclip UI (authenticated user).
 */
export const createSubIssueTool: ToolDef<typeof inputSchema> = {
  name: "create_sub_issue",
  title: "Create sub-issue (delegate)",
  description:
    "Create a sub-issue (child of an existing issue) assigned to another agent. Use for delegation within an ongoing work tree. REQUIRES parentIssueId — on adapter-assigned runs it must equal the issue you're currently working on. Agents cannot create un-parented (top-level) work; new investigations/initiatives are set up by the board via Routines or manual assignment.",
  inputSchema,
  async execute(
    { title, description, assigneeAgentId, parentIssueId, priority },
    { client, log, assertWriteScope },
  ) {
    const { companyId } = client.config;
    if (!companyId) {
      return errorResult(
        "PAPERCLIP_COMPANY_ID is not set. The adapter normally sets it — please report this.",
        "abort",
      );
    }

    // parentIssueId is schema-required, but zod still lets the empty
    // string through. Reject that explicitly so the scope check below
    // can't be spoofed by an LLM passing "" (which would pass the env
    // comparison since scopedIssueId is never empty).
    if (!parentIssueId || !parentIssueId.trim()) {
      log("create_sub_issue MISSING_PARENT", {});
      return errorResult(
        "create_sub_issue: parentIssueId is required. Agents cannot create top-level (un-parented) work via MCP — new initiatives are set up by the board via Routines or manual assignment. If you need to delegate a side-quest, do it as a sub-issue of your current task.",
        "fix-args",
      );
    }

    try {
      assertWriteScope(parentIssueId);
    } catch (err) {
      if (err instanceof ScopeViolation) {
        log("create_sub_issue SCOPE_VIOLATION", { parentIssueId, scope: err.scope });
        return errorResult(
          `create_sub_issue: ${err.message}. parentIssueId must equal the issue you're currently working on. To spin off unrelated work, ask the board to add a Routine or assign a new top-level issue.`,
          "fix-args",
        );
      }
      throw err;
    }

    try {
      const payload: Record<string, unknown> = {
        title,
        description,
        assigneeAgentId,
        parentIssueId,
      };
      if (priority !== undefined) payload.priority = priority;

      const created = await client.post<unknown>(
        `/companies/${companyId}/issues`,
        payload,
      );
      log("create_sub_issue ok", {
        assigneeAgentId,
        parentIssueId,
      });
      return okResult(created);
    } catch (err) {
      if (err instanceof PaperclipClientError) {
        return errorResult(
          `create_sub_issue: Paperclip API error (${err.status}) ${err.message}`,
          classifyHttp(err.status),
          err.body,
        );
      }
      return errorResult(
        `create_sub_issue: ${(err as Error)?.message ?? String(err)}`,
        "retry",
      );
    }
  },
};
