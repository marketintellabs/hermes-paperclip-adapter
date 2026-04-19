import { z } from "zod";
import { PaperclipClientError } from "../client.js";
import { classifyHttp, errorResult, okResult, type ToolDef } from "./types.js";

const inputSchema = {
  issueId: z
    .string()
    .min(1)
    .describe(
      "Issue UUID (e.g. '01HQ...') or identifier (e.g. 'MAR-42'). Both are accepted by the Paperclip API.",
    ),
  includeComments: z
    .boolean()
    .optional()
    .describe("If true, include the full comment thread. Default false to keep payloads small."),
};

/**
 * get_issue — fetch the full payload for a single issue.
 *
 * Replaces `curl .../issues/{id}` + manual JSON parsing from the
 * v2 prompt. Reads are NOT scope-checked — an agent may need to look
 * at a parent issue, a delegated child, or a referenced task for
 * context. Writes (post_issue_comment, etc.) are what the scope
 * guard protects.
 */
export const getIssueTool: ToolDef<typeof inputSchema> = {
  name: "get_issue",
  title: "Get issue",
  description:
    "Fetch full details for an issue by its id or identifier. Returns the raw Paperclip issue object. Pass includeComments: true to also load the comment thread.",
  inputSchema,
  async execute({ issueId, includeComments }, { client, log }) {
    try {
      const issue = await client.get<unknown>(`/issues/${issueId}`);
      if (!includeComments) {
        log("get_issue ok", { issueId, includeComments: false });
        return okResult(issue);
      }
      const comments = await client.get<unknown>(`/issues/${issueId}/comments`);
      log("get_issue ok", { issueId, includeComments: true });
      return okResult({ issue, comments });
    } catch (err) {
      if (err instanceof PaperclipClientError) {
        return errorResult(
          `get_issue: Paperclip API error (${err.status}) ${err.message}`,
          classifyHttp(err.status),
          err.body,
        );
      }
      return errorResult(
        `get_issue: ${(err as Error)?.message ?? String(err)}`,
        "retry",
      );
    }
  },
};
