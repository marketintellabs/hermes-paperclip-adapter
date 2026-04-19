import { z } from "zod";
import { PaperclipClientError } from "../client.js";
import {
  classifyHttp,
  errorResult,
  okResult,
  ScopeViolation,
  type ToolDef,
} from "./types.js";

/**
 * Allowed target statuses the LLM can transition TO via this tool.
 *
 * We intentionally do not expose every Paperclip status — only the
 * outcomes an agent could reasonably claim:
 *   done           → work finished, deliverable attached
 *   blocked        → an external dependency or missing input stops progress
 *   needs_review   → work drafted but requires human/peer sign-off
 *
 * Deliberately excluded:
 *   todo / backlog / in_progress → the scheduler and the act of picking up
 *     the work owns these; letting the agent rewrite them would race with
 *     the heartbeat scheduler.
 *   cancelled → out-of-band admin concept; a regular agent shouldn't cancel.
 */
const ALLOWED_STATUSES = ["done", "blocked", "needs_review"] as const;

const inputSchema = {
  issueId: z
    .string()
    .min(1)
    .describe(
      "Issue id or identifier to transition. On adapter-assigned runs this MUST match the issue you were assigned (scope-enforced).",
    ),
  status: z
    .enum(ALLOWED_STATUSES)
    .describe(
      "New terminal status. Use 'done' when the deliverable is complete, 'blocked' when an external dependency stops you, 'needs_review' when a human must sign off before the work ships.",
    ),
  reason: z
    .string()
    .max(2_000)
    .optional()
    .describe(
      "Short (1–3 sentence) justification. REQUIRED when status=blocked so the reviewer knows what to unblock; strongly encouraged for needs_review.",
    ),
};

/**
 * update_issue_status — transition the current run's issue to a terminal status.
 *
 * This is the structured replacement for the `RESULT: done|blocked|needs_review`
 * stdout marker that adapter-owned-status templates (v2+) use to signal
 * completion. Calling the tool explicitly is strictly better than the
 * marker because:
 *   - it returns an error if the transition is rejected (bad scope, bad
 *     status name) — the marker silently no-ops if misspelled.
 *   - it shows up in the tool-call audit log.
 *   - it eliminates a whole class of "the LLM forgot the marker" bugs.
 *
 * The adapter's post-run reconciler still honours the `RESULT:` marker as
 * a fallback for backward compatibility, so agents that forget to call
 * this tool but emit a correct marker still work. Calling the tool
 * wins over the marker if both are present.
 *
 * Scope-enforced: like post_issue_comment, this refuses to transition any
 * issue other than the one the run is scoped to (PAPERCLIP_ISSUE_ID).
 */
export const updateIssueStatusTool: ToolDef<typeof inputSchema> = {
  name: "update_issue_status",
  title: "Update issue status",
  description:
    "Transition the current issue to a terminal status (done | blocked | needs_review). Call this AS THE LAST tool in your run, right before you end. Replaces the legacy `RESULT: done` stdout marker — using this tool is strictly preferred because it returns an error on rejection and appears in the audit log. This tool is scope-restricted to your assigned issue. Provide `reason` when status=blocked.",
  inputSchema,
  async execute({ issueId, status, reason }, { client, log, assertWriteScope }) {
    try {
      assertWriteScope(issueId);
    } catch (err) {
      if (err instanceof ScopeViolation) {
        log("update_issue_status SCOPE_VIOLATION", { issueId, scope: err.scope, status });
        return errorResult(
          `update_issue_status: ${err.message}. You can only transition your own assigned issue.`,
          "fix-args",
        );
      }
      throw err;
    }

    // Enforce `reason` for blocked — Paperclip doesn't require it at the
    // API level, but a blocked issue with no context is operationally
    // useless. Fail fast with a clear message so the LLM retries with
    // the reason included rather than Paperclip accepting it and a
    // human wondering "blocked on what?" later.
    if (status === "blocked" && (!reason || reason.trim().length === 0)) {
      log("update_issue_status missing_reason", { issueId, status });
      return errorResult(
        `update_issue_status: 'reason' is required when status=blocked. Pass a short (1–3 sentence) description of what is blocking you.`,
        "fix-args",
      );
    }

    try {
      const body: Record<string, unknown> = { status };
      if (reason && reason.trim().length > 0) {
        body.statusReason = reason.trim();
      }
      const updated = await client.patch<unknown>(`/issues/${issueId}`, body);
      log("update_issue_status ok", { issueId, status, hasReason: !!reason });
      return okResult(updated);
    } catch (err) {
      if (err instanceof PaperclipClientError) {
        return errorResult(
          `update_issue_status: Paperclip API error (${err.status}) ${err.message}`,
          classifyHttp(err.status),
          err.body,
        );
      }
      return errorResult(
        `update_issue_status: ${(err as Error)?.message ?? String(err)}`,
        "retry",
      );
    }
  },
};
