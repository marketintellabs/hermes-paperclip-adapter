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
 * Issue-thread interaction kinds supported by Paperclip's
 * `POST /issues/:id/interactions` endpoint as of v2026.428.0.
 *
 * The upstream contract is **BETA** — kind names, payload shapes, and
 * `continuationPolicy` semantics may shift before the API stabilises.
 * This tool intentionally treats `payload` as opaque (`z.unknown()`)
 * and forwards it without re-validation: the upstream zod schema
 * (`createIssueThreadInteractionSchema` in the Paperclip server) is
 * the single source of truth, and duplicating it here would force a
 * lockstep release every time upstream tweaks a field name. When the
 * API exits BETA we'll consider tightening the adapter-side schema.
 *
 * Today's three kinds:
 *
 *   - `suggest_tasks` — propose 1-50 child tasks the user (or a board
 *     member) can accept-as-a-batch via the issue thread UI. The
 *     accepted set becomes real Paperclip issues with the suggested
 *     parent / priority / assignee / project. Useful for delegators
 *     proposing a decomposition that's too consequential to fan out
 *     unilaterally via `create_sub_issues`.
 *   - `ask_user_questions` — present a short multi-question form
 *     (1-10 questions, single or multi-select, up to 10 options each)
 *     to the user inline in the issue thread. Replaces "post a comment
 *     listing the questions and wait" with a structured survey that
 *     produces typed answers the next run can read.
 *   - `request_confirmation` — single accept/reject on a specific
 *     proposal with optional rich `detailsMarkdown`, accept/reject
 *     labels, and a `target` reference (issue document revision or
 *     custom key) so the confirmation is tied to a concrete artifact
 *     rather than an abstract intent. The Tier-2 publish-vs-hold flow
 *     for LinkedIn / X / podcast distribution agents lives here.
 */
const ISSUE_INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
] as const;

const inputSchema = {
  issueId: z
    .string()
    .min(1)
    .describe(
      "Issue id or identifier to attach the interaction to. Scope-restricted: on adapter-assigned runs you can only post interactions on your assigned issue.",
    ),
  kind: z
    .enum(ISSUE_INTERACTION_KINDS)
    .describe(
      "Interaction kind. Use `request_confirmation` for Tier-2 approvals (publish vs hold, irreversible action gates). Use `suggest_tasks` to propose a decomposition the user batch-approves. Use `ask_user_questions` to gather typed answers via a short form. Each kind has its own `payload` shape — see Paperclip's createIssueThreadInteractionSchema.",
    ),
  payload: z
    .unknown()
    .describe(
      "Kind-specific payload object. The upstream API validates the shape via createIssueThreadInteractionSchema; see Paperclip docs (or v2026.428.0 source at packages/shared/src/validators/issue.ts §suggestTasksPayloadSchema/askUserQuestionsPayloadSchema/requestConfirmationPayloadSchema) for the exact fields and limits.",
    ),
  idempotencyKey: z
    .string()
    .max(255)
    .nullable()
    .optional()
    .describe(
      "Optional idempotency key. If a non-null key has been used on this issue before, the API returns the original interaction record instead of creating a duplicate. Useful when retrying after a transient failure or when the LLM might re-propose the same interaction across heartbeats.",
    ),
  title: z
    .string()
    .max(240)
    .nullable()
    .optional()
    .describe("Optional short headline shown above the interaction in the UI."),
  summary: z
    .string()
    .max(1000)
    .nullable()
    .optional()
    .describe("Optional one-paragraph rationale shown below the interaction title."),
  continuationPolicy: z
    .enum(["wake_assignee", "none"])
    .optional()
    .describe(
      "What Paperclip should do when the user resolves the interaction. `wake_assignee` (default for suggest_tasks/ask_user_questions) re-wakes the issue's current assignee on accept/respond so the agent can act on the new state. `none` (default for request_confirmation) leaves the assignee dormant — useful when the agent has already finished its current run and just needs a record of the user's decision.",
    ),
};

/**
 * post_issue_interaction — write a structured issue-thread interaction.
 *
 * Replaces the marker-convention pattern (`<!-- mode: test -->`,
 * `RESULT: done`) for high-stakes coordination signals. While the
 * markers continue to work in 0.8.x, agents that adopt this tool get
 * three things the markers cannot provide:
 *
 *   1. **Persisted typed records.** Each interaction is a row in
 *      `issue_thread_interactions` with kind / payload / status /
 *      result fields, so dashboards and audits don't have to scrape
 *      free-form comment markdown.
 *   2. **Deterministic UI rendering.** The Paperclip web UI knows how
 *      to render every kind — accept/reject buttons for confirmations,
 *      a select-which-tasks form for suggestions, a typed multi-select
 *      form for questions. Marker comments rely on whatever the LLM
 *      happened to write.
 *   3. **Server-mediated continuation.** When the user resolves the
 *      interaction, Paperclip's continuation engine wakes the assignee
 *      with the resolution attached, instead of the agent having to
 *      poll for a comment-shaped response.
 *
 * Scope-enforced: on adapter-assigned runs (`PAPERCLIP_ISSUE_ID` set),
 * the tool refuses interactions on any other issue. Heartbeat runs
 * have no scope and can target any issue.
 *
 * `sourceRunId` is auto-populated from `PAPERCLIP_RUN_ID` env so the
 * persisted record traces back to the run that posted it. This is the
 * same env var the adapter sets in `hermes-home.ts §writeConfig` for
 * any v3+ run; older templates that don't run paperclip-mcp can't
 * call this tool anyway.
 *
 * Wire-format note: BETA. See top-of-file docstring on why payload
 * is opaque on the adapter side.
 */
export const postIssueInteractionTool: ToolDef<typeof inputSchema> = {
  name: "post_issue_interaction",
  title: "Post issue thread interaction",
  description:
    "Post a structured issue-thread interaction (request_confirmation / suggest_tasks / ask_user_questions) to the upstream IssueInteraction API. Use request_confirmation for Tier-2 approvals (publish vs hold, irreversible action gates), suggest_tasks to propose a decomposition the user batch-approves, ask_user_questions to gather typed answers via a short form. The persisted record is rendered by the Paperclip UI and survives across runs — preferable to free-form marker comments for high-stakes coordination signals. Scope-restricted: on adapter-assigned runs you can only target your assigned issue.",
  inputSchema,
  async execute(
    {
      issueId,
      kind,
      payload,
      idempotencyKey,
      title,
      summary,
      continuationPolicy,
    },
    { client, log, assertWriteScope },
  ) {
    try {
      assertWriteScope(issueId);
    } catch (err) {
      if (err instanceof ScopeViolation) {
        log("post_issue_interaction SCOPE_VIOLATION", {
          issueId,
          scope: err.scope,
        });
        return errorResult(
          `post_issue_interaction: ${err.message}. On adapter-assigned runs, you can only target your assigned issue.`,
          "fix-args",
        );
      }
      throw err;
    }

    // Adapter-mediated source-run linkage. The upstream POST handler
    // (server/src/routes/issues.ts §router.post(/issues/:id/interactions))
    // accepts an optional `sourceRunId`; we always pass it so the
    // persisted record traces back to a heartbeat run, even if the
    // LLM doesn't think to provide it. Falls back gracefully when the
    // env var is unset (e.g. development MCP-server invocations).
    const sourceRunId = process.env.PAPERCLIP_RUN_ID || undefined;

    const body: Record<string, unknown> = { kind, payload };
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      body.idempotencyKey = idempotencyKey;
    }
    if (title !== undefined && title !== null) body.title = title;
    if (summary !== undefined && summary !== null) body.summary = summary;
    if (continuationPolicy !== undefined) {
      body.continuationPolicy = continuationPolicy;
    }
    if (sourceRunId) body.sourceRunId = sourceRunId;

    try {
      const interaction = await client.post<unknown>(
        `/issues/${issueId}/interactions`,
        body,
      );
      log("post_issue_interaction ok", {
        issueId,
        kind,
        idempotencyKey: idempotencyKey ?? null,
        sourceRunId: sourceRunId ?? null,
      });
      return okResult(interaction);
    } catch (err) {
      if (err instanceof PaperclipClientError) {
        // 422s on this endpoint usually mean the payload didn't match
        // the kind-specific schema. Forward the upstream `body` so the
        // LLM can read the validation message and fix its next attempt
        // — same pattern post_issue_comment uses for clarity.
        return errorResult(
          `post_issue_interaction: Paperclip API error (${err.status}) ${err.message}`,
          classifyHttp(err.status),
          err.body,
        );
      }
      return errorResult(
        `post_issue_interaction: ${(err as Error)?.message ?? String(err)}`,
        "retry",
      );
    }
  },
};
