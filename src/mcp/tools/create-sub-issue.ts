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
    .optional()
    .describe(
      "Optional parent issue id. When set, the new issue is linked as a child and blocks parent completion until resolved.",
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
 * create_sub_issue — delegate work by creating a new issue.
 *
 * Replaces the delegation curl example from v2. When `parentIssueId`
 * is provided, the created issue is linked back to the parent so the
 * blocker graph stays intact.
 *
 * Scope-enforced on `parentIssueId`: on adapter-assigned runs, the
 * parent must match the assigned issue. Creating NEW top-level work
 * (no parent) is always allowed — that's a valid delegation pattern.
 */
export const createSubIssueTool: ToolDef<typeof inputSchema> = {
  name: "create_sub_issue",
  title: "Create sub-issue (delegate)",
  description:
    "Create a new issue assigned to another agent. Use for delegation. Always provide a concrete title + description with acceptance criteria. If this delegation is in service of the issue you're currently working on, pass parentIssueId so the blocker graph stays intact — on adapter-assigned runs parentIssueId is restricted to your own issue.",
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

    if (parentIssueId) {
      try {
        assertWriteScope(parentIssueId);
      } catch (err) {
        if (err instanceof ScopeViolation) {
          log("create_sub_issue SCOPE_VIOLATION", { parentIssueId, scope: err.scope });
          return errorResult(
            `create_sub_issue: ${err.message}. You can only set parentIssueId to the issue you're currently working on. Omit parentIssueId to create top-level work, or run this delegation as part of the parent issue.`,
            "fix-args",
          );
        }
        throw err;
      }
    }

    try {
      const payload: Record<string, unknown> = {
        title,
        description,
        assigneeAgentId,
      };
      if (parentIssueId) payload.parentIssueId = parentIssueId;
      if (priority !== undefined) payload.priority = priority;

      const created = await client.post<unknown>(
        `/companies/${companyId}/issues`,
        payload,
      );
      log("create_sub_issue ok", {
        assigneeAgentId,
        parentIssueId: parentIssueId ?? null,
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
