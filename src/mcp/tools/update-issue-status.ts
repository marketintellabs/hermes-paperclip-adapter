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

/**
 * Statuses that an agent must never transition OUT of. An issue in one of
 * these states is considered closed by an operator (or by a previous
 * completed run) and should be immutable from the agent side.
 *
 * This guards against a bug-class we observed in the wild on 2026-05-03:
 *
 *   1. Operator cancels a test-fixture issue (status: cancelled) and
 *      adds a "do not use as research input" warning comment.
 *   2. The cancellation PATCH itself fires Paperclip's "issue mutated"
 *      wake hook on the issue's assignee.
 *   3. The agent wakes ~10 min later, reads the issue body (which still
 *      contains the original task instructions), runs the work, and
 *      calls update_issue_status(done) — silently overriding the
 *      operator's `cancelled` decision.
 *
 * Without this guard, operator cleanup is not durable across heartbeats:
 * any post-cancellation wake can re-promote a cancelled issue back to
 * a working state. The guard makes terminal states truly terminal from
 * the agent side. An admin (or a human via Paperclip's Board UI) can
 * still transition out via direct API calls; only the agent-facing
 * MCP tool refuses.
 *
 * `done` is included because re-promoting a done issue (rare but
 * possible if a stale wake fires after an out-of-band restart) would
 * have the same operator-trust problem.
 */
const TERMINAL_STATUSES = new Set(["cancelled", "done"] as const);

interface IssueStatusSnapshot {
  status?: string;
}

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

    // Terminal-state guard — read the issue's current status FIRST and
    // refuse to transition out of cancelled/done. This makes operator
    // cleanup durable across heartbeats: once a human (or a previous
    // agent run) closes an issue, no subsequent agent wake can silently
    // re-promote it. See top-of-file docstring on the 2026-05-03 incident
    // that motivated this guard. The extra GET costs ~50–150ms per
    // update_issue_status call — a bounded cost paid once at run end.
    let currentStatus: string | undefined;
    try {
      const snapshot = await client.get<IssueStatusSnapshot>(`/issues/${issueId}`);
      currentStatus = typeof snapshot?.status === "string" ? snapshot.status : undefined;
    } catch (err) {
      // If we can't read the current status, fall through — the PATCH
      // below will surface any underlying error (auth/404/network) with
      // its own retry policy. Don't block the legitimate transition just
      // because the read failed.
      log("update_issue_status precheck_read_failed", {
        issueId,
        error: (err as Error)?.message ?? String(err),
      });
    }

    if (
      currentStatus !== undefined &&
      TERMINAL_STATUSES.has(currentStatus as "cancelled" | "done") &&
      currentStatus !== status
    ) {
      log("update_issue_status terminal_state_protected", {
        issueId,
        currentStatus,
        requestedStatus: status,
      });
      return errorResult(
        `update_issue_status: issue is already in terminal state '${currentStatus}' and cannot transition to '${status}'. ` +
          `An operator or a previous run closed this issue; do not contest that decision. ` +
          `Stop work on this issue and look for new work via list_my_issues.`,
        "abort",
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
