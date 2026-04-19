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
  issueId: z.string().min(1).describe("Issue id or identifier to comment on."),
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe("Markdown body of the comment. Keep it concise and high-signal."),
};

/**
 * post_issue_comment — post a comment to an issue.
 *
 * Intended for in-run progress updates, delegation notes, or answering
 * @mentions. DO NOT use for final completion summaries — the adapter
 * posts a structured completion comment automatically based on the
 * RESULT: marker.
 *
 * Scope-enforced: if the run is bound to a specific issue
 * (PAPERCLIP_ISSUE_ID set by the adapter), this tool will refuse to
 * comment on any other issue. Heartbeat runs have no scope and can
 * comment anywhere.
 */
export const postIssueCommentTool: ToolDef<typeof inputSchema> = {
  name: "post_issue_comment",
  title: "Post issue comment",
  description:
    "Post a markdown comment to an issue. Use for progress updates, delegation handoffs, or replies to @mentions. Do NOT use for final completion summaries — the adapter posts those automatically when you end your run with a RESULT: marker. This tool is scope-restricted: on adapter-assigned runs you can only comment on your assigned issue.",
  inputSchema,
  async execute({ issueId, body }, { client, log, assertWriteScope }) {
    try {
      assertWriteScope(issueId);
    } catch (err) {
      if (err instanceof ScopeViolation) {
        log("post_issue_comment SCOPE_VIOLATION", { issueId, scope: err.scope });
        return errorResult(
          `post_issue_comment: ${err.message}. On adapter-assigned runs, you can only comment on the issue you were assigned. To coordinate with another issue, either end this run and let the adapter spawn a new one, or call create_sub_issue.`,
          "fix-args",
        );
      }
      throw err;
    }

    try {
      const comment = await client.post<unknown>(`/issues/${issueId}/comments`, { body });
      log("post_issue_comment ok", { issueId, bodyLen: body.length });
      return okResult(comment);
    } catch (err) {
      if (err instanceof PaperclipClientError) {
        return errorResult(
          `post_issue_comment: Paperclip API error (${err.status}) ${err.message}`,
          classifyHttp(err.status),
          err.body,
        );
      }
      return errorResult(
        `post_issue_comment: ${(err as Error)?.message ?? String(err)}`,
        "retry",
      );
    }
  },
};
