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
 * Hard cap on sub-issues per call. The LLM-facing schema enforces
 * `<= 10` (zod), but we re-check at runtime as defense in depth — the
 * SDK could theoretically pass a parsed value that bypassed schema
 * validation, and a 50-item bulk delegate would DoS Paperclip's API.
 *
 * 10 is the empirical CEO ceiling: a strategic decomposition that
 * spawns more than 10 parallel children is almost certainly the LLM
 * looping or fabricating work. The singular `create_sub_issue` is
 * still available for the rare case where a delegator legitimately
 * needs to issue 11+ children — but they'd burn 11 MCP-call slots
 * (out of 20), which is its own circuit breaker.
 */
export const MAX_SUB_ISSUES_PER_CALL = 10;

/**
 * Per-sub-issue spec inside the array. Mirrors the singular tool's
 * schema EXCEPT `parentIssueId` is hoisted to the outer call (every
 * sub-issue in one call shares a parent — that's the whole point).
 *
 * Fields kept structurally identical to {@link createSubIssueTool}'s
 * input so the per-item fan-out below can reuse the same payload-name
 * translation (`parentIssueId` → `parentId`, `status: "todo"`).
 */
const subIssueSpec = z.object({
  title: z.string().min(3).max(300).describe("Short title (3–300 chars)."),
  description: z
    .string()
    .min(1)
    .describe(
      "Full markdown description with acceptance criteria and context the assignee needs.",
    ),
  assigneeAgentId: z
    .string()
    .describe("UUID of the agent to assign this sub-issue to. Required — don't create unassigned work."),
  priority: z
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe("0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low."),
});

const inputSchema = {
  parentIssueId: z
    .string()
    .describe(
      "REQUIRED. The parent issue ALL sub-issues will be children of. On adapter-assigned runs this MUST equal the issue you're currently working on. Agents cannot create un-parented work — that comes from the board via Routines or manual assignment.",
    ),
  subIssues: z
    .array(subIssueSpec)
    .min(1)
    .max(MAX_SUB_ISSUES_PER_CALL)
    .describe(
      `Array of sub-issues to create in parallel under the same parent. Use this when delegating multiple distinct sub-tasks at once (e.g. a CEO decomposing one investigation into 5 research streams). For a SINGLE delegation use create_sub_issue instead. Capped at ${MAX_SUB_ISSUES_PER_CALL} per call.`,
    ),
};

export type CreateSubIssuesInput = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * Per-sub-issue result emitted to the LLM. Never throws — every
 * outcome is normalised into this shape so the caller gets a
 * deterministic structure they can iterate over.
 */
interface SubIssueOutcome {
  index: number;
  ok: boolean;
  /** Populated on success. The full issue object Paperclip returned. */
  issue?: unknown;
  /** Populated on failure. Human-readable error from this one child. */
  error?: string;
  /**
   * Populated on failure when the failure looks transient. Mirrors the
   * singular tool's retry policy so a partial-failure call can be
   * retried for ONLY the failed children.
   */
  retryPolicy?: "retry" | "fix-args" | "abort";
}

/**
 * Build the same sub-issue POST payload the singular tool builds.
 * Centralised here so the wire-shape contract — `parentId` (NOT
 * `parentIssueId`), explicit `status: "todo"` so `on_assign` fires —
 * lives in exactly one helper. See `create-sub-issue.ts` for the
 * MAR-204/206/207 (2026-04-25) regression history that motivates
 * both fields.
 */
function buildPayload(
  spec: z.infer<typeof subIssueSpec>,
  parentIssueId: string,
  description: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: spec.title,
    description,
    assigneeAgentId: spec.assigneeAgentId,
    parentId: parentIssueId,
    status: "todo",
  };
  if (spec.priority !== undefined) payload.priority = spec.priority;
  return payload;
}

/**
 * Test-mode marker injection — copy of the singular tool's logic, kept
 * inline to preserve "every sub-issue body is what an operator would
 * have typed by hand" idempotency. Mutating the description happens
 * BEFORE the POST so the marker lands in the persisted issue body and
 * the assignee's mode probe picks it up.
 */
function applyTestModeInheritance(description: string): string {
  if (process.env.PAPERCLIP_TEST_MODE !== "1") return description;
  const ALREADY = /<!--\s*mode\s*:\s*test\s*-->/i;
  if (ALREADY.test(description)) return description;
  const src =
    process.env.PAPERCLIP_TEST_MODE_SOURCE_DETAIL ||
    process.env.PAPERCLIP_TEST_MODE_SOURCE ||
    "parent run";
  return (
    `<!-- mode: test -->\n` +
    `<!-- inherited from parent: ${src} -->\n\n` +
    description
  );
}

/**
 * create_sub_issues — bulk delegation by creating multiple sub-issues
 * in parallel under a shared parent.
 *
 * Why a separate plural tool instead of overloading `create_sub_issue`:
 *
 *   - **One MCP call-budget unit, N children.** A CEO decomposing into
 *     5 sub-issues used to burn 5 of the 20 MAX_TOOL_CALLS slots.
 *     Plural collapses that to 1 slot, leaving budget for follow-up
 *     comments and status updates without having to grow the cap.
 *
 *   - **Wall-clock saving.** 5 sequential POSTs against the API
 *     (network RTT + Paperclip's per-issue work) typically cost
 *     10–15s. `Promise.allSettled` brings that to a single RTT
 *     bounded by the slowest child. The CEO's strategic decomposition
 *     no longer dominates run time.
 *
 *   - **Partial-failure semantics.** With `Promise.allSettled` one
 *     400/500 on child #3 can't sink children #1, #2, #4, #5. The
 *     LLM gets a per-item outcome array and can retry only the
 *     failed indices — same retryPolicy contract as the singular
 *     tool. Rejecting on first failure (`Promise.all`) would have
 *     been simpler but fragile under the kind of transient 503 we
 *     see during heavy fan-out windows.
 *
 *   - **Scope check is shared.** All sub-issues hang off the same
 *     `parentIssueId`, so the scope guard runs once for the whole
 *     batch instead of 5 times. Cleaner audit trail too:
 *     `create_sub_issues SCOPE_VIOLATION` shows up once per attempt.
 *
 * Singular {@link createSubIssueTool} is preserved unchanged — it's
 * the right shape for one-off delegations and doesn't pay the
 * complexity tax of the bulk path. Both tools live behind the same
 * `can_delegate` allowlist gate, so adding the plural doesn't widen
 * the security surface beyond what delegators already have.
 */
export const createSubIssuesTool: ToolDef<typeof inputSchema> = {
  name: "create_sub_issues",
  title: "Create sub-issues in parallel (bulk delegate)",
  description:
    "Create multiple sub-issues in parallel under one shared parent. Use for bulk delegation (e.g. CEO decomposing into N research streams). For a single delegation use create_sub_issue. parentIssueId is REQUIRED and on adapter-assigned runs must equal your current issue. Capped at 10 sub-issues per call. Partial-failure tolerant — one bad child won't fail the others.",
  inputSchema,
  async execute(
    { parentIssueId, subIssues },
    { client, log, assertWriteScope },
  ) {
    const { companyId } = client.config;
    if (!companyId) {
      return errorResult(
        "PAPERCLIP_COMPANY_ID is not set. The adapter normally sets it — please report this.",
        "abort",
      );
    }

    if (!parentIssueId || !parentIssueId.trim()) {
      log("create_sub_issues MISSING_PARENT", { count: subIssues.length });
      return errorResult(
        "create_sub_issues: parentIssueId is required. Agents cannot create top-level (un-parented) work via MCP — new initiatives are set up by the board via Routines or manual assignment. If you need to delegate side-quests, do them as sub-issues of your current task.",
        "fix-args",
      );
    }

    if (subIssues.length > MAX_SUB_ISSUES_PER_CALL) {
      // Belt-and-suspenders: zod already capped at MAX_SUB_ISSUES_PER_CALL,
      // but the McpServer.registerTool path could theoretically pass an
      // already-parsed value that bypassed schema validation (e.g. a
      // future SDK rewrite). A bulk fan-out of 50 children would DoS
      // Paperclip's POST /issues handler.
      log("create_sub_issues TOO_MANY", {
        count: subIssues.length,
        max: MAX_SUB_ISSUES_PER_CALL,
      });
      return errorResult(
        `create_sub_issues: too many sub-issues (${subIssues.length} > ${MAX_SUB_ISSUES_PER_CALL}). Split into multiple calls or use create_sub_issue per child if you legitimately need more than ${MAX_SUB_ISSUES_PER_CALL}.`,
        "fix-args",
      );
    }

    try {
      assertWriteScope(parentIssueId);
    } catch (err) {
      if (err instanceof ScopeViolation) {
        log("create_sub_issues SCOPE_VIOLATION", {
          parentIssueId,
          scope: err.scope,
          count: subIssues.length,
        });
        return errorResult(
          `create_sub_issues: ${err.message}. parentIssueId must equal the issue you're currently working on. To spin off unrelated work, ask the board to add a Routine or assign a new top-level issue.`,
          "fix-args",
        );
      }
      throw err;
    }

    const startedAt = Date.now();

    // Run every POST in parallel via allSettled so a 4xx/5xx on one
    // child cannot poison the others. Each child is independently
    // shaped and classified — the LLM consumes a deterministic
    // results array with a per-item retryPolicy.
    const settled = await Promise.allSettled(
      subIssues.map(async (spec, index): Promise<SubIssueOutcome> => {
        const description = applyTestModeInheritance(spec.description);
        const payload = buildPayload(spec, parentIssueId, description);
        try {
          const created = await client.post<unknown>(
            `/companies/${companyId}/issues`,
            payload,
          );
          return { index, ok: true, issue: created };
        } catch (err) {
          if (err instanceof PaperclipClientError) {
            return {
              index,
              ok: false,
              error: `Paperclip API error (${err.status}) ${err.message}`,
              retryPolicy: classifyHttp(err.status),
            };
          }
          return {
            index,
            ok: false,
            error: (err as Error)?.message ?? String(err),
            retryPolicy: "retry",
          };
        }
      }),
    );

    // `Promise.allSettled` only `rejected`s if the mapper itself threw
    // synchronously — every per-child branch above resolves with a
    // SubIssueOutcome, so in practice only the mapper's outer throw
    // (e.g. zod parse failure on a malformed item) lands here. We
    // still normalise it into the same shape so the LLM never sees a
    // half-typed array.
    const outcomes: SubIssueOutcome[] = settled.map((r, index) => {
      if (r.status === "fulfilled") return r.value;
      return {
        index,
        ok: false,
        error: (r.reason as Error)?.message ?? String(r.reason),
        retryPolicy: "retry",
      };
    });

    const ok = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - ok;
    const durationMs = Date.now() - startedAt;

    log("create_sub_issues result", {
      parentIssueId,
      requested: subIssues.length,
      ok,
      failed,
      durationMs,
    });

    // Test-mode marker emission is per-child (already applied inside
    // the description). Emit a single rollup log line so the audit
    // log shows that test mode was active for this batch — keeps
    // grep-by-issue parity with the singular tool's
    // `create_sub_issue test_mode_inherit` event.
    if (process.env.PAPERCLIP_TEST_MODE === "1") {
      log("create_sub_issues test_mode_inherit", {
        source: process.env.PAPERCLIP_TEST_MODE_SOURCE,
        parentIssueId,
        count: subIssues.length,
      });
    }

    // Normalised result envelope. Always returned via okResult() so
    // the LLM sees the per-item array even when SOME children failed.
    // The aggregate `ok: false` flag is set only when ALL children
    // failed (full failure → retry strategy is the same as if the
    // whole tool call failed; partial → caller decides per index).
    const summary = {
      parentIssueId,
      requested: subIssues.length,
      succeeded: ok,
      failed,
      durationMs,
      results: outcomes,
    };

    if (ok === 0) {
      // All-failure path: surface as an error result so the LLM's
      // tool-error handling kicks in (and the audit log gets a
      // tool_call_error event). retryPolicy reflects the worst case
      // across children — if ANY child saw a 4xx/fix-args, we want
      // the LLM to fix args before retrying; otherwise retry.
      const anyFixArgs = outcomes.some((o) => o.retryPolicy === "fix-args");
      const anyAbort = outcomes.some((o) => o.retryPolicy === "abort");
      const aggregatePolicy = anyAbort
        ? "abort"
        : anyFixArgs
          ? "fix-args"
          : "retry";
      return errorResult(
        `create_sub_issues: all ${subIssues.length} sub-issue creations failed. See per-item results for details.`,
        aggregatePolicy,
        summary,
      );
    }

    return okResult(summary);
  },
};
