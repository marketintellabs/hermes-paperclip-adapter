/**
 * Pre-flight check: avoid invoking Hermes (and burning LLM credits) when
 * there is no work for this agent to do.
 *
 * Motivation
 * ----------
 * Historically, when an agent's heartbeat fired without a specific assigned
 * issue, the adapter would still spawn Hermes. The LLM would execute the
 * prompt's "no task" branch, which instructs it to curl the issues API and
 * look for work itself. That costs real tokens on every wake — typically
 * 2-6k input tokens plus a few turns of thinking — even when the answer is
 * "nothing to do".
 *
 * With the 2026-04-04 autonomy policy (see
 * `docs/incidents/2026-04-04-autonomous-work-loop.md`), every agent is now
 * `on_assign` and the only recurring wake path is board-owned Routines
 * creating concrete issues. That means the common case is: taskId is set.
 * But we keep getting edge cases where an agent wakes without a taskId:
 *   - Operator clicks "Wake up" in the UI before an issue is assigned.
 *   - A routine trigger fires twice in quick succession and the second one
 *     coalesces; the wake event still arrives.
 *   - A future regression re-enables a heartbeat by mistake.
 *
 * In every one of those cases we now want a cheap, non-LLM answer from the
 * Paperclip API: "does this agent have any open assigned issues?". If the
 * answer is "zero", we return an early-exit result without spawning Hermes.
 * The cost is one ~50-200ms HTTP GET; the saving is one LLM turn (easily
 * $0.01-$0.05 depending on the agent's model tier).
 *
 * Fail-open
 * ---------
 * Every unknown answers "proceed". If we can't make the API call (missing
 * key, network error, non-2xx, malformed JSON), or we're missing the agent
 * / company IDs, we let the run continue. The pre-flight is a cost
 * optimization, not a gate — never silently skip real work.
 */

export interface PreflightDecision {
  action: "proceed" | "skip";
  reason: string;
  openIssueCount: number | null;
}

export interface PreflightInput {
  /** Task ID resolved from the run context. If non-empty, we always proceed. */
  taskId: string;
  /** Comment ID resolved from the run context. If non-empty, we always proceed. */
  commentId: string;
  /** Paperclip API base URL (with `/api` suffix guaranteed by caller). */
  apiBase: string;
  /** Bearer token. If undefined, we cannot check; fail-open. */
  apiKey: string | undefined;
  agentId: string | undefined;
  companyId: string | undefined;
  /** Per-wake reason string from ctx.context. Used only for diagnostics. */
  wakeReason?: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Timeout for the issues list call, in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
}

/**
 * Statuses we treat as "open" for the purpose of pre-flight. Matches
 * Paperclip's `OPEN_ISSUE_STATUSES` minus the cases where waking the agent
 * is pointless (`done`, `cancelled`). `in_review` and `blocked` are open
 * because the agent may need to respond.
 */
const OPEN_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

interface MinimalIssue {
  id?: unknown;
  status?: unknown;
  assigneeAgentId?: unknown;
}

function isOpenIssue(raw: MinimalIssue): boolean {
  return typeof raw.status === "string" && OPEN_STATUSES.has(raw.status);
}

/**
 * Decide whether to proceed with this run or short-circuit as a no-op.
 *
 * The function performs at most one HTTP GET. On any doubt it returns
 * `{ action: "proceed" }` so callers can pipe the decision straight into
 * an `if (decision.action === "skip") return earlyNoopResult;` check.
 */
export async function preflightAssignedWork(
  input: PreflightInput,
): Promise<PreflightDecision> {
  // Rule 1 — explicit work. A task id or comment id in the run context
  // means Paperclip handed us a specific thing to do. Always proceed.
  if (input.taskId) {
    return {
      action: "proceed",
      reason: "task_assigned",
      openIssueCount: null,
    };
  }
  if (input.commentId) {
    return {
      action: "proceed",
      reason: "comment_event",
      openIssueCount: null,
    };
  }

  // Rule 2 — can't check. Without an API key or agent/company IDs we have
  // no way to query; fall through and let the run continue.
  if (!input.apiKey) {
    return {
      action: "proceed",
      reason: "preflight_skipped_no_api_key",
      openIssueCount: null,
    };
  }
  if (!input.agentId || !input.companyId) {
    return {
      action: "proceed",
      reason: "preflight_skipped_missing_ids",
      openIssueCount: null,
    };
  }

  // Rule 3 — ask the API.
  const url =
    `${input.apiBase}/companies/${encodeURIComponent(input.companyId)}/issues` +
    `?assigneeAgentId=${encodeURIComponent(input.agentId)}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      action: "proceed",
      reason: `preflight_error_network:${(err as Error).message ?? String(err)}`,
      openIssueCount: null,
    };
  }

  if (!response.ok) {
    return {
      action: "proceed",
      reason: `preflight_error_http:${response.status}`,
      openIssueCount: null,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    return {
      action: "proceed",
      reason: `preflight_error_parse:${(err as Error).message ?? String(err)}`,
      openIssueCount: null,
    };
  }

  const issues = Array.isArray(payload)
    ? (payload as MinimalIssue[])
    : Array.isArray((payload as { issues?: unknown })?.issues)
      ? ((payload as { issues: MinimalIssue[] }).issues)
      : null;

  if (!issues) {
    return {
      action: "proceed",
      reason: "preflight_error_unexpected_shape",
      openIssueCount: null,
    };
  }

  const openCount = issues.filter(isOpenIssue).length;

  if (openCount === 0) {
    return {
      action: "skip",
      reason: "no_open_assigned_issues",
      openIssueCount: 0,
    };
  }

  return {
    action: "proceed",
    reason: "open_issues_found",
    openIssueCount: openCount,
  };
}
