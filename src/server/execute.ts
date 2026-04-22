/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
  BUILTIN_PROMPT_TEMPLATES,
  BUILTIN_PROMPT_TEMPLATE_PREFIX,
  ADAPTER_OWNED_STATUS_TEMPLATES,
  MCP_TOOL_TEMPLATES,
} from "../shared/constants.js";

import { buildPerRunHermesHome } from "./hermes-home.js";
import type { PerRunHermesHome } from "./hermes-home.js";
import { collectMcpTelemetry, type McpTelemetry } from "./mcp-telemetry.js";
import { scanForBypass } from "./bypass-detector.js";
import { sessionExistsInHermesDb, resolveRealHermesHome } from "./session-probe.js";
import { preflightAssignedWork } from "./preflight.js";
import { ADAPTER_VERSION } from "../shared/version.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";

import {
  parseResultMarker,
  stripResultMarker,
  type ResultMarker,
  type RunOutcome,
} from "./result-marker.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

// ---------------------------------------------------------------------------
// Run-context field resolution (taskId / taskTitle / wakeReason / …)
// ---------------------------------------------------------------------------
//
// Paperclip's AdapterExecutionContext exposes two sibling bags of data:
//
//   - ctx.config  — the agent's adapterConfig (static per-agent settings).
//   - ctx.context — the per-run context snapshot (per-issue / per-wake data
//                   such as taskId, issueId, wakeReason, wakeSource, …).
//
// Historically this adapter read per-run fields from ctx.config. That was
// latent-wrong: on modern Paperclip (>= 2026.4, confirmed against
// @paperclipai/adapter-utils@2026.416.0) the heartbeat service builds
// `runtimeConfig` from `effectiveResolvedConfig` only, without merging the
// run context into it, so `ctx.config.taskId` is silently undefined. The
// effect on legacy templates (builtin:mil-heartbeat) was mild — the LLM
// fetched its own issue via tools so the empty Mustache {{#taskId}} block
// was only a usability papercut. On the 0.4.x adapter-owned-status path,
// however, an empty taskId silently closed the `adapterOwnedStatus &&
// taskId && paperclipClient.apiKey` gate, so `preRunClaim` and
// `reconcileOutcome` were both no-ops — which is what caused MAR-27/MAR-28
// to get escalated to `blocked` even after the LLM emitted RESULT: done.
//
// `resolveRunContextField` prefers ctx.context (canonical), falls back to
// ctx.config (legacy callers), and returns the empty string if neither has
// it. The returned provenance lets us log exactly where each field came
// from so future misconfigurations self-diagnose on the next smoke test
// instead of leaking into a DB dig.
type FieldProvenance = "context" | "config" | "missing";

export interface ResolvedField {
  value: string;
  source: FieldProvenance;
}

export function resolveRunContextField(
  ctx: Pick<AdapterExecutionContext, "config" | "context">,
  key: string,
): ResolvedField {
  const fromContext = cfgString((ctx.context as Record<string, unknown> | undefined)?.[key]);
  if (fromContext) return { value: fromContext, source: "context" };
  const fromConfig = cfgString((ctx.config as Record<string, unknown> | undefined)?.[key]);
  if (fromConfig) return { value: fromConfig, source: "config" };
  return { value: "", source: "missing" };
}

/**
 * Snapshot of all per-run fields the adapter currently consumes. Produced
 * once at the top of {@link execute} and threaded through prompt-building,
 * preRunClaim, reconcileOutcome, and diagnostic logging so the adapter
 * reads each field from the canonical place exactly once.
 */
export interface RunContext {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  commentId: string;
  wakeReason: string;
  companyName: string;
  projectName: string;
  workspaceDir: string;
  /**
   * Per-field provenance. Keys match the fields above. Used by the
   * `[hermes] run context:` diagnostic log line.
   */
  provenance: Record<string, FieldProvenance>;
}

export function buildRunContext(ctx: AdapterExecutionContext): RunContext {
  const fields: Array<keyof Omit<RunContext, "provenance">> = [
    "taskId",
    "taskTitle",
    "taskBody",
    "commentId",
    "wakeReason",
    "companyName",
    "projectName",
    "workspaceDir",
  ];
  const out: Partial<RunContext> = { provenance: {} };
  for (const f of fields) {
    const r = resolveRunContextField(ctx, f);
    (out as Record<string, unknown>)[f] = r.value;
    out.provenance![f] = r.source;
  }
  return out as RunContext;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"status\"]:>12} {i[\"priority\"]:>6} {i[\"title\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"title\"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

interface ResolvedTemplate {
  /** Rendered template text (with {{var}} placeholders unresolved). */
  text: string;
  /**
   * Builtin template name (e.g. `"mil-heartbeat-v2"`) if the caller
   * resolved via `builtin:<name>`; `null` otherwise. Used downstream to
   * decide whether to activate adapter-owned status transitions.
   */
  builtinName: string | null;
}

/**
 * Resolve `adapterConfig.promptTemplate`:
 *   - `undefined` / empty  → DEFAULT_PROMPT_TEMPLATE (builtinName=null)
 *   - `"builtin:<name>"`   → load `templates/<name>.md` shipped with this package
 *   - any other string     → use as-is (with {{var}} placeholders)
 *
 * Added by the MarketIntelLabs fork so operators can reference a vetted
 * template by name instead of shipping a giant string in every agent's
 * adapterConfig. The returned `builtinName` lets downstream code enable
 * per-template behaviours such as adapter-owned status transitions.
 */
function resolvePromptTemplate(raw: string | undefined): ResolvedTemplate {
  if (!raw) return { text: DEFAULT_PROMPT_TEMPLATE, builtinName: null };
  if (!raw.startsWith(BUILTIN_PROMPT_TEMPLATE_PREFIX)) {
    return { text: raw, builtinName: null };
  }

  const name = raw.slice(BUILTIN_PROMPT_TEMPLATE_PREFIX.length);
  if (!(BUILTIN_PROMPT_TEMPLATES as readonly string[]).includes(name)) {
    throw new Error(
      `Unknown builtin promptTemplate "${raw}". ` +
        `Available: ${BUILTIN_PROMPT_TEMPLATES.map((n) => BUILTIN_PROMPT_TEMPLATE_PREFIX + n).join(", ")}`,
    );
  }

  // Templates live at <package-root>/templates/<name>.md.
  // From dist/server/execute.js that's three levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  const templatePath = join(here, "..", "..", "templates", `${name}.md`);
  return { text: readFileSync(templatePath, "utf-8"), builtinName: name };
}

interface BuiltPrompt {
  text: string;
  /**
   * Builtin template name that produced this prompt, or `null` for
   * caller-supplied raw templates. Downstream code uses this to gate
   * adapter-owned status transitions.
   */
  builtinName: string | null;
}

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  run: RunContext,
): BuiltPrompt {
  const resolved = resolvePromptTemplate(cfgString(config.promptTemplate));
  const template = resolved.text;

  const taskId = run.taskId;
  const taskTitle = run.taskTitle;
  const taskBody = run.taskBody;
  const commentId = run.commentId;
  const wakeReason = run.wakeReason;
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = run.companyName;
  const projectName = run.projectName;

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
  };

  // Handle conditional sections: {{#key}}...{{/key}}
  let rendered = template;

  // {{#taskId}}...{{/taskId}} — include if task is assigned
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );

  // {{#noTask}}...{{/noTask}} — include if no task
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );

  // {{#commentId}}...{{/commentId}} — include if comment exists
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
  );

  // Replace remaining {{variable}} placeholders
  return {
    text: renderTemplate(rendered, vars),
    builtinName: resolved.builtinName,
  };
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/**
 * Regex for legacy (non-quiet) session output format. Must be strict: only
 * accept the exact `session_id:` / `session id:` / `session saved:` prefix
 * followed by an id-shaped token. Earlier versions matched the looser
 * `/session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i` which false-positives
 * on Hermes' own error text (`"Session not found: from\nUse a session ID
 * from a previous CLI run"` → captured "from" and poisoned paperclip's
 * stored session id, see the 2026-04-19 MAR-30 heartbeat crash loop).
 *
 * We also anchor to line start and require the colon to exclude the
 * `session ID from` phrase entirely.
 */
const SESSION_ID_REGEX_LEGACY =
  /(?:^|\n)\s*session[_ ](?:id|saved)\s*:\s*([A-Za-z0-9][A-Za-z0-9_-]{7,})\b/i;

/**
 * Shape-validate a candidate session id before trusting it. Hermes session
 * ids are UUID-like (hyphenated hex) or long opaque tokens; they are never
 * short English words. Rejecting these prevents stderr-fragment regex
 * false-positives from poisoning `session_id_after`.
 *
 * Exported for unit tests.
 */
export function isPlausibleSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  if (id.length < 8) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(id)) return false;
  // Dictionary-like tokens ("fromprevious", "session") are not session ids.
  // Require either a digit, a hyphen, or an underscore.
  if (!/[0-9_-]/.test(id)) return false;
  return true;
}

/**
 * Decide whether a stored `prevSessionId` is safe to pass to
 * `hermes chat --resume <id>`. Two layers of defence, in order:
 *
 *   1. Shape check (0.8.3+): reject tokens that don't look like a real
 *      session id ("from", "run", short English words, etc.). Catches
 *      the classic regex-false-positive case where Hermes' own
 *      "Session not found: <token>" error prose poisons the stored
 *      session id.
 *
 *   2. Existence probe (0.8.5+, optional): look up the id in Hermes'
 *      `state.db`. If state.db says the id is not there, reject with
 *      `reason = "not_in_state_db"`. Catches plausibly-shaped session
 *      ids that were wiped from disk after being persisted by
 *      paperclip (container restarts, state.db resets, etc.). Pass
 *      `probe: sessionExistsInHermesDb` from execute() to enable; the
 *      probe is injected rather than imported here so unit tests can
 *      stub it without touching SQLite.
 *
 * The probe is fail-open: if it returns `exists: null` (no db, IO
 * error, native sqlite missing) we trust the caller — Hermes' own
 * lookup is the ultimate authority and we'd rather occasionally let
 * a broken resume through than reject every resume when the probe
 * misbehaves.
 *
 * Returns the validated id (empty string when rejected or absent)
 * plus a rejection reason so callers can log meaningful diagnostics.
 *
 * Exported for unit tests.
 */
export type ResumeResolutionReason =
  | "empty"
  | "ok_shape_only"
  | "ok_probe_confirmed"
  | "ok_probe_unavailable"
  | "rejected_shape"
  | "rejected_not_in_state_db";

export interface ResumeResolution {
  sessionId: string;
  rejected: boolean;
  reason: ResumeResolutionReason;
  /** Probe diagnostic — populated when a probe ran (null otherwise). */
  probeDetail?: string;
}

export function resolveResumeSessionId(
  raw: string | null | undefined,
  probe?: (id: string) => { exists: boolean | null; reason?: string },
): ResumeResolution {
  if (!raw) return { sessionId: "", rejected: false, reason: "empty" };
  if (!isPlausibleSessionId(raw)) {
    return { sessionId: "", rejected: true, reason: "rejected_shape" };
  }
  if (!probe) {
    return { sessionId: raw, rejected: false, reason: "ok_shape_only" };
  }
  const result = probe(raw);
  if (result.exists === true) {
    return { sessionId: raw, rejected: false, reason: "ok_probe_confirmed" };
  }
  if (result.exists === false) {
    return {
      sessionId: "",
      rejected: true,
      reason: "rejected_not_in_state_db",
      probeDetail: result.reason,
    };
  }
  return {
    sessionId: raw,
    rejected: false,
    reason: "ok_probe_unavailable",
    probeDetail: result.reason,
  };
}

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

export interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Paperclip API client (minimal, best-effort)
// ---------------------------------------------------------------------------

type LogFn = (stream: "stdout" | "stderr", line: string) => Promise<void> | void;

interface PaperclipApiClient {
  /** Base URL with guaranteed `/api` suffix. */
  base: string;
  /** Bearer token (may be undefined — caller should skip writes in that case). */
  apiKey: string | undefined;
  log: LogFn;
}

function buildPaperclipClient(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  env: Record<string, string>,
): PaperclipApiClient {
  let base =
    cfgString(config.paperclipApiUrl) ||
    env.PAPERCLIP_API_URL ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  if (!base.endsWith("/api")) {
    base = base.replace(/\/+$/, "") + "/api";
  }
  const apiKey =
    env.PAPERCLIP_API_KEY || (ctx as any).authToken || undefined;
  return { base, apiKey, log: ctx.onLog };
}

async function getIssueStatus(
  client: PaperclipApiClient,
  issueId: string,
): Promise<string | undefined> {
  if (!client.apiKey) return undefined;
  const url = `${client.base}/issues/${encodeURIComponent(issueId)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${client.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await client.log(
        "stdout",
        `[hermes] GET ${url} -> ${res.status} ${res.statusText}\n`,
      );
      return undefined;
    }
    const body = (await res.json()) as { status?: string };
    return typeof body?.status === "string" ? body.status : undefined;
  } catch (err) {
    await client.log(
      "stdout",
      `[hermes] GET ${url} failed: ${(err as Error)?.message ?? err}\n`,
    );
    return undefined;
  }
}

async function patchIssueStatus(
  client: PaperclipApiClient,
  issueId: string,
  status: "in_progress" | "done" | "blocked" | "cancelled",
): Promise<boolean> {
  if (!client.apiKey) return false;
  const url = `${client.base}/issues/${encodeURIComponent(issueId)}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await client.log(
        "stderr",
        `[hermes] PATCH ${url} status=${status} -> ${res.status} ${res.statusText}\n`,
      );
      return false;
    }
    return true;
  } catch (err) {
    await client.log(
      "stderr",
      `[hermes] PATCH ${url} status=${status} failed: ${(err as Error)?.message ?? err}\n`,
    );
    return false;
  }
}

async function postIssueComment(
  client: PaperclipApiClient,
  issueId: string,
  body: string,
): Promise<boolean> {
  if (!client.apiKey || !body.trim()) return false;
  const url = `${client.base}/issues/${encodeURIComponent(issueId)}/comments`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await client.log(
        "stderr",
        `[hermes] POST ${url} -> ${res.status} ${res.statusText}\n`,
      );
      return false;
    }
    return true;
  } catch (err) {
    await client.log(
      "stderr",
      `[hermes] POST ${url} failed: ${(err as Error)?.message ?? err}\n`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pre-run claim
// ---------------------------------------------------------------------------

/**
 * For adapter-owned-status templates, ensure the issue is `in_progress`
 * before we hand control to Hermes. The LLM no longer needs to emit a
 * `status=in_progress` curl from its prompt, which keeps the template
 * small and prevents a whole class of "LLM forgot to claim" bugs.
 *
 * Behaviour:
 *   - If the issue is `todo` or `backlog`, PATCH to `in_progress`.
 *   - If it is already `in_progress`, no-op (Paperclip or a prior
 *     heartbeat claimed it for us).
 *   - If it is terminal (`done`/`blocked`/`cancelled`), log a warning
 *     and leave the status alone. This should not normally happen but
 *     protects against Paperclip dispatching stale work.
 *
 * All errors are swallowed — a failed pre-run claim is not a reason to
 * abort the whole run. Paperclip's reconciler will notice and retry.
 */
async function preRunClaim(
  client: PaperclipApiClient,
  taskId: string,
): Promise<void> {
  const current = await getIssueStatus(client, taskId);
  if (!current) return;

  if (current === "in_progress") {
    await client.log(
      "stdout",
      `[hermes] pre-run claim: ${taskId} already 'in_progress', skipping PATCH\n`,
    );
    return;
  }

  const terminal = new Set(["done", "blocked", "cancelled"]);
  if (terminal.has(current)) {
    await client.log(
      "stderr",
      `[hermes] pre-run claim: ${taskId} is already '${current}'; ` +
        `Paperclip dispatched a run against a terminal issue — continuing but not changing status\n`,
    );
    return;
  }

  if (current === "todo" || current === "backlog") {
    const ok = await patchIssueStatus(client, taskId, "in_progress");
    if (ok) {
      await client.log(
        "stdout",
        `[hermes] pre-run claim: patched ${taskId} '${current}' -> 'in_progress'\n`,
      );
    }
    return;
  }

  // Unknown status — log but don't touch.
  await client.log(
    "stdout",
    `[hermes] pre-run claim: ${taskId} has unexpected status '${current}'; leaving alone\n`,
  );
}

// ---------------------------------------------------------------------------
// Post-run outcome reconciliation
// ---------------------------------------------------------------------------

/**
 * For adapter-owned-status templates, transition the issue to a terminal
 * status based on the LLM's `RESULT:` marker (see
 * `./result-marker.ts`) and post a structured completion comment.
 *
 * This is the proper replacement for the 0.3.2-mil.0 `ensureTerminalStatus`
 * safety-net: when the prompt template is adapter-owned, we are the
 * canonical source of truth for status transitions, and the LLM should
 * never be emitting `curl .../status=...` itself.
 *
 * Behaviour:
 *   - Only activates on a successful Hermes exit (exit 0, no timeout,
 *     no parsed error) with a `taskId` present. Failed runs are left
 *     for Paperclip's execution-policy retry loop.
 *   - Parses the RESULT marker from the assistant summary; defaults to
 *     `done` if none is present (and logs a prompt-following warning).
 *   - Respects terminal statuses already on the issue — the LLM may
 *     have been mid-edit when we read; we don't clobber `blocked` with
 *     `done`.
 *   - PATCHes the issue to the marker's outcome and POSTs a completion
 *     comment containing the stripped summary and, for non-`done`
 *     outcomes, the LLM's stated reason.
 *
 * All API errors are logged but non-fatal.
 */
async function reconcileOutcome(args: {
  client: PaperclipApiClient;
  taskId: string;
  agentName: string;
  summary: string;
  marker: ResultMarker | null;
  markerPresent: boolean;
}): Promise<RunOutcome> {
  const { client, taskId, agentName, summary, marker, markerPresent } = args;

  if (!markerPresent) {
    await client.log(
      "stdout",
      `[hermes] post-run: no RESULT marker found in agent response; ` +
        `defaulting to 'done'. Agents using 'builtin:mil-heartbeat-v2' should ` +
        `end their final message with 'RESULT: done' / 'RESULT: blocked' / ` +
        `'RESULT: cancelled' explicitly.\n`,
    );
  }

  const outcome: RunOutcome = marker?.outcome ?? "done";

  const current = await getIssueStatus(client, taskId);
  const terminal = new Set(["done", "blocked", "cancelled"]);
  if (current && terminal.has(current)) {
    await client.log(
      "stdout",
      `[hermes] post-run: ${taskId} is already '${current}', not overriding ` +
        `(LLM or prior run set it explicitly)\n`,
    );
    return outcome;
  }

  const ok = await patchIssueStatus(client, taskId, outcome);
  if (ok) {
    await client.log(
      "stdout",
      `[hermes] post-run: patched ${taskId} -> '${outcome}' (marker ${markerPresent ? "present" : "defaulted"})\n`,
    );
  }

  const commentBody = buildCompletionCommentBody({
    agentName,
    outcome,
    summary,
    reason: marker?.reason,
  });
  if (commentBody) {
    await postIssueComment(client, taskId, commentBody);
  }

  return outcome;
}

/**
 * Build the structured completion comment the adapter posts after it
 * transitions the issue to a terminal status. Format:
 *
 *   **<Agent Name>** completed via `hermes` adapter — `RESULT: done`
 *
 *   <stripped summary>
 *
 * For `blocked`/`cancelled` outcomes the LLM's `reason:` is surfaced on
 * its own line so the issue reader sees the escalation rationale
 * without reading the agent log.
 */
function buildCompletionCommentBody(args: {
  agentName: string;
  outcome: RunOutcome;
  summary: string;
  reason: string | undefined;
}): string {
  const { agentName, outcome, summary, reason } = args;
  const lines: string[] = [];
  lines.push(`**${agentName}** completed via \`hermes\` adapter — \`RESULT: ${outcome}\``);
  if (reason && outcome !== "done") {
    lines.push("");
    lines.push(`Reason: ${reason}`);
  }
  const trimmedSummary = summary.trim();
  if (trimmedSummary) {
    lines.push("");
    lines.push(trimmedSummary);
  }
  return lines.join("\n");
}

/**
 * Pre-0.4.0 safety-net reconciler (the 0.3.2-mil.0 fix).
 *
 * Retained for agents using the legacy `mil-heartbeat` template (or
 * any non-adapter-owned template) where the LLM is still expected to
 * emit its own status curls. In those flows we only intervene when:
 *
 *   - the run succeeded (exit 0, no timeout, no error), and
 *   - the issue is still `todo`/`in_progress` after the run.
 *
 * We then PATCH to `done` to close the reconciler race window.
 * Terminal statuses (`done`/`blocked`/`cancelled`) are respected so the
 * LLM can still intentionally escalate via its own curl.
 */
async function ensureTerminalStatusSafetyNet(
  client: PaperclipApiClient,
  taskId: string,
): Promise<void> {
  const current = await getIssueStatus(client, taskId);
  if (!current) return;
  const terminal = new Set(["done", "blocked", "cancelled"]);
  if (terminal.has(current)) return;
  if (current !== "todo" && current !== "in_progress") return;

  await client.log(
    "stdout",
    `[hermes] post-run safety-net: run succeeded but issue still '${current}'; ` +
      `patching to 'done' to close the reconciler race window\n`,
  );
  const ok = await patchIssueStatus(client, taskId, "done");
  if (ok) {
    await client.log(
      "stdout",
      `[hermes] post-run safety-net: patched ${taskId} -> 'done'\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  // Before attempting any session-id extraction, look for explicit
  // "Session not found" / "Use a session ID" error text. When Hermes
  // aborts because of a bad --resume id, our extracted token is almost
  // certainly a false-positive from that error message and must not be
  // propagated back to paperclip (otherwise the next heartbeat replays
  // the poisoned id and crashes again — see the legacy-regex fix above).
  const sessionErrorPresent =
    /Session not found\s*:/i.test(combined) ||
    /Use a session ID from a previous CLI run/i.test(combined);

  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1] && isPlausibleSessionId(sessionMatch[1])) {
    result.sessionId = sessionMatch[1];
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode). Only trust it if we don't see
    // Hermes' own "Session not found" error nearby, and the token looks
    // like a real session id.
    if (!sessionErrorPresent) {
      const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
      if (legacyMatch?.[1] && isPlausibleSessionId(legacyMatch[1])) {
        result.sessionId = legacyMatch[1];
      }
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Capture real error signatures from stderr for diagnostics.
  //
  // IMPORTANT: This field is informational only. It must NOT gate whether
  // the adapter treats the run as successful — that is the exit code's job.
  // Hermes (and its underlying tools: MCP, camoufox, Playwright, etc.) emit
  // a lot of benign stderr output that contains the words "error" / "failed"
  // in perfectly successful runs (e.g. "retrying after error", "No error
  // detected", "failed to resolve optional dependency"). Treating those as
  // failure signals previously caused adapter-owned status reconciliation to
  // silently skip on successful runs (MAR-27, 2026-04-19).
  //
  // We match only strong failure signatures: lines that START with a known
  // error prefix, plus Python tracebacks and unhandled-rejection markers.
  if (stderr.trim()) {
    const STRONG_ERROR_PREFIX =
      /^(?:error|fatal|unhandled exception|unhandledrejection|panic|traceback \(most recent call last\))[:\s]/i;
    const errorLines = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && STRONG_ERROR_PREFIX.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line));
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    model,
  });

  // ── Resolve per-run context once (canonical source for all fields) ─────
  // See `resolveRunContextField` for the rationale: Paperclip puts per-run
  // data on ctx.context, not ctx.config. We resolve once here and thread
  // the snapshot through prompt-building, env wiring, preRunClaim, and
  // reconcileOutcome so no downstream reader silently re-reads the wrong
  // bag.
  const run = buildRunContext(ctx);

  // ── Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(ctx, config, run);
  const adapterOwnedStatus =
    prompt.builtinName !== null &&
    ADAPTER_OWNED_STATUS_TEMPLATES.has(prompt.builtinName);
  const useMcpToolServer =
    prompt.builtinName !== null &&
    MCP_TOOL_TEMPLATES.has(prompt.builtinName);

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt.text];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  // Session resume. Two layers of defence — see resolveResumeSessionId:
  //   1. shape check (0.8.3) — reject session-like strings that can't
  //      possibly be real (regex-false-positive case).
  //   2. state.db existence probe (0.8.5) — reject plausibly-shaped
  //      ids that aren't in Hermes' SQLite session table anymore
  //      (container restarts, state.db resets, etc.).
  // Both rejections produce a fresh session on this run rather than a
  // `Session not found: <id>` crash loop.
  const prevSessionIdRaw = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  const resumeProbe = (id: string) => {
    const r = sessionExistsInHermesDb(id, resolveRealHermesHome(process.env));
    return { exists: r.exists, reason: "reason" in r ? r.reason : undefined };
  };
  const resume = resolveResumeSessionId(
    prevSessionIdRaw,
    persistSession ? resumeProbe : undefined,
  );
  if (persistSession && resume.rejected) {
    const summary =
      resume.reason === "rejected_shape"
        ? "shape check failed"
        : `not found in state.db${resume.probeDetail ? ` (${resume.probeDetail})` : ""}`;
    await ctx.onLog(
      "stdout",
      `[hermes] rejecting prevSessionId=${JSON.stringify(
        prevSessionIdRaw,
      )} (${summary}) — will create a fresh session\n`,
    );
  } else if (persistSession && resume.reason === "ok_probe_unavailable") {
    // Non-fatal diagnostic: probe couldn't confirm existence, but we're
    // letting the resume through. Log once per run so a wave of
    // probe-unavailable resumes is discoverable via stdout_excerpt
    // searches without having to correlate exit codes.
    await ctx.onLog(
      "stdout",
      `[hermes] session-probe unavailable (${resume.probeDetail ?? "unknown"}) — resuming on shape-only trust\n`,
    );
  }
  if (persistSession && resume.sessionId) {
    args.push("--resume", resume.sessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  if ((ctx as any).authToken && !env.PAPERCLIP_API_KEY)
    env.PAPERCLIP_API_KEY = (ctx as any).authToken;
  const taskId = run.taskId;
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  const userEnv = config.env as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") {
    Object.assign(env, userEnv);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  // `config.cwd` is adapterConfig.cwd (static). `run.workspaceDir` is the
  // per-run workspace (ctx.context.workspaceDir with ctx.config.workspaceDir
  // fallback for legacy callers).
  const cwd = cfgString(config.cwd) || run.workspaceDir || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (resume.sessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${resume.sessionId}\n`,
    );
  }
  if (prompt.builtinName) {
    await ctx.onLog(
      "stdout",
      `[hermes] Prompt template: builtin:${prompt.builtinName}` +
        `${adapterOwnedStatus ? " (adapter-owned status)" : ""}\n`,
    );
  }

  // Debug-log the shape of ctx.context so we can plan PR #3 (skills +
  // blocker graph consumption) against real data. ctx.context is the
  // adapter contract's structured issue metadata surface (separate from
  // ctx.config); today we don't consume it, but seeing its keys on a
  // real run lets us scope what's available without a staging detour.
  // Values are not logged (may contain sensitive summaries).
  if (ctx.context && typeof ctx.context === "object") {
    const keys = Object.keys(ctx.context);
    if (keys.length > 0) {
      await ctx.onLog(
        "stdout",
        `[hermes] ctx.context keys: [${keys.join(", ")}]\n`,
      );
    }
  }

  // ── Build Paperclip API client (used for pre-run claim + post-run) ─────
  const paperclipClient = buildPaperclipClient(ctx, config, env);

  // ── Pre-flight: is there any work to do? ───────────────────────────────
  // Avoid spawning Hermes (and burning an LLM turn) when this agent has
  // no taskId, no comment event, AND no open assigned issues. See
  // `preflight.ts` for the policy (fail-open on every ambiguous answer).
  //
  // Opt-out via adapterConfig.preflightSkip=false (default true). This is
  // here as a belt-and-suspenders in case the API check is somehow
  // breaking a legitimate wake path in production; operators can turn it
  // off per-agent without a new release.
  const preflightEnabled = cfgBoolean(config.preflightSkip) !== false;
  if (preflightEnabled) {
    const decision = await preflightAssignedWork({
      taskId: run.taskId,
      commentId: run.commentId,
      apiBase: paperclipClient.base,
      apiKey: paperclipClient.apiKey,
      agentId: ctx.agent?.id,
      companyId: ctx.agent?.companyId,
      wakeReason: run.wakeReason,
    });

    await ctx.onLog(
      "stdout",
      `[hermes] preflight: action=${decision.action} reason=${decision.reason}` +
        (decision.openIssueCount !== null
          ? ` openIssueCount=${decision.openIssueCount}`
          : "") +
        "\n",
    );

    if (decision.action === "skip") {
      await ctx.onLog(
        "stdout",
        `[hermes] No assigned work for ${ctx.agent?.name ?? "agent"}; ` +
          `skipping Hermes invocation (zero LLM cost).\n`,
      );
      const skippedResult: AdapterExecutionResult = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: resolvedProvider,
        model,
        summary:
          `No assigned work for this agent; skipped Hermes invocation ` +
          `(preflight: ${decision.reason}).`,
        resultJson: {
          adapterVersion: ADAPTER_VERSION,
          preflight: "skipped",
          preflight_reason: decision.reason,
          preflight_open_issue_count: decision.openIssueCount,
        },
      };
      return skippedResult;
    }
  }

  // Self-diagnostic: the adapter-owned-status path has three gates
  // (`adapterOwnedStatus && taskId && paperclipClient.apiKey`). If any one
  // closes silently, both preRunClaim and reconcileOutcome become no-ops
  // and the issue gets escalated to `blocked` by Paperclip's reconciler
  // (see MAR-27/MAR-28 regressions). Log the gate state AND the provenance
  // of each run-context field so the next failure self-diagnoses without
  // a DB dig.
  const provenanceSummary = Object.entries(run.provenance)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  await ctx.onLog(
    "stdout",
    `[hermes] adapter-owned gate: adapterOwnedStatus=${adapterOwnedStatus} ` +
      `taskId=${taskId ? "set" : "missing"} ` +
      `apiKey=${paperclipClient.apiKey ? "set" : "missing"}\n`,
  );
  await ctx.onLog(
    "stdout",
    `[hermes] run context provenance: ${provenanceSummary}\n`,
  );

  // ── Pre-run claim (adapter-owned-status templates only) ────────────────
  // For legacy templates, the LLM still handles PATCH status=in_progress
  // via curl from the prompt. Skipping keeps behaviour identical for
  // agents still on builtin:mil-heartbeat.
  if (adapterOwnedStatus && taskId && paperclipClient.apiKey) {
    await preRunClaim(paperclipClient, taskId);
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  // ── Per-run HERMES_HOME with Paperclip MCP tool server ────────────────
  // When the template is MCP-enabled (builtin:mil-heartbeat-v3+), we build
  // a per-run HERMES_HOME temp dir so hermes picks up a `mcp_servers.paperclip`
  // block carrying THIS run's scope (authToken, agentId, companyId, issueId)
  // in its env. A shared config.yaml can't carry per-run scope without
  // racing across concurrent agents that share a department container.
  // See src/server/hermes-home.ts for the symlink scheme that preserves
  // session resume + skills while isolating config.yaml.
  let perRunHome: PerRunHermesHome | null = null;
  if (useMcpToolServer) {
    if (!paperclipClient.apiKey) {
      // Fail fast — a v3 template agent with no apiKey would boot an MCP
      // server that couldn't authenticate any call; every tool would 401.
      throw new Error(
        `[hermes] mcp-tool template (${prompt.builtinName}) requires a ` +
          `Paperclip API key. ctx.authToken / env PAPERCLIP_API_KEY / ` +
          `adapterConfig.paperclipApiKey are all empty. Refusing to spawn.`,
      );
    }
    // Per-agent MCP tool allowlist from adapterConfig. When absent,
    // the MCP server registers every tool in ALL_TOOLS (backward
    // compatible). See paperclip/company-template.json for the canonical
    // per-agent lists.
    const paperclipMcpTools = cfgStringArray(config.paperclipMcpTools);

    perRunHome = await buildPerRunHermesHome(ctx.runId || "no-run-id", {
      apiUrl: paperclipClient.base,
      apiKey: paperclipClient.apiKey,
      agentId: ctx.agent?.id ?? null,
      companyId: ctx.agent?.companyId ?? null,
      issueId: taskId ?? null,
      runId: ctx.runId ?? null,
      allowedTools: paperclipMcpTools ?? null,
    });
    env.HERMES_HOME = perRunHome.path;
    // Note: setting telemetry vars on the adapter's own env does NOT help —
    // Hermes' `_build_safe_env` (tools/mcp_tool.py) intentionally filters
    // parent env down to a baseline allowlist (PATH/HOME/USER/LANG/TERM/…
    // plus XDG_*) and only merges the explicit `mcp_servers.<name>.env`
    // block from config.yaml on top. So the ONLY way PAPERCLIP_MCP_AUDIT_LOG
    // reaches the MCP subprocess is via hermes-home.ts baking it into the
    // per-run config.yaml (which it does). Keeping this comment so the
    // next person doesn't re-add the belt-and-suspenders env assignment.
    await ctx.onLog(
      "stdout",
      `[hermes] MCP tool server enabled; HERMES_HOME=${perRunHome.path} ` +
        `(scope: agent=${ctx.agent?.id || "?"} issue=${taskId || "none"}` +
        (paperclipMcpTools
          ? ` tools=[${paperclipMcpTools.join(",")}]`
          : " tools=<all>") +
        `)\n`,
    );
    // Diagnostic: surface the presence of telemetry keys in the per-run
    // config.yaml so we can tell at a glance whether the env block got
    // built correctly. Values are NOT logged (they are filesystem paths
    // with the runId, but we treat config.yaml as write-only + 0600).
    try {
      const perRunYaml = await readFile(join(perRunHome.path, "config.yaml"), "utf-8");
      const paperclipBlock = perRunYaml.match(/\n\s{2}paperclip:\n[\s\S]*?(?=\n\S|$)/);
      const hasAudit = /PAPERCLIP_MCP_AUDIT_LOG:\s*\S/.test(paperclipBlock?.[0] ?? "");
      const hasLiveness = /PAPERCLIP_MCP_LIVENESS_FILE:\s*\S/.test(paperclipBlock?.[0] ?? "");
      await ctx.onLog(
        "stdout",
        `[hermes] per-run config.yaml env: audit=${hasAudit} liveness=${hasLiveness} ` +
          `(bytes=${perRunYaml.length})\n`,
      );
    } catch (err) {
      await ctx.onLog(
        "stdout",
        `[hermes] per-run config.yaml read failed: ${(err as Error).message}\n`,
      );
    }
  }

  let result;
  // MCP telemetry is collected BEFORE cleanup because the audit log +
  // liveness file both live inside the per-run HERMES_HOME tempdir,
  // which cleanup() blows away. Null when no MCP tool server was
  // spawned for this run (legacy templates).
  let mcpTelemetry: McpTelemetry | null = null;
  try {
    result = await runChildProcess(ctx.runId, hermesCmd, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
    });
  } finally {
    if (perRunHome) {
      try {
        mcpTelemetry = await collectMcpTelemetry(
          perRunHome.auditLogPath,
          perRunHome.livenessFilePath,
        );
      } catch (err) {
        // Telemetry collection must NEVER break a run. If the NDJSON
        // is unreadable we just lose observability for this run and
        // log the reason to stderr.
        await ctx.onLog(
          "stderr",
          `[hermes] mcp telemetry collection failed (non-fatal): ${
            (err as Error).message
          }\n`,
        );
      }
      try {
        await perRunHome.cleanup();
      } catch (err) {
        // Cleanup failure is non-fatal — the dir lives under /tmp and
        // the kernel/OS reaper will eventually clear it. Don't mask
        // the real run outcome.
        await ctx.onLog(
          "stderr",
          `[hermes] per-run HERMES_HOME cleanup failed (non-fatal): ${
            (err as Error).message
          }\n`,
        );
      }
    }
  }

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response.
  //
  // Always strip any `RESULT:` marker before exposing the response to
  // Paperclip's auto-comment / UI, otherwise the marker leaks into the
  // issue thread even when adapter-owned status reconciliation later
  // decides (correctly) not to post a structured completion comment.
  // stripResultMarker is a no-op when the marker is absent.
  const cleanedResponse = parsed.response ? stripResultMarker(parsed.response) : "";
  if (cleanedResponse) {
    executionResult.summary = cleanedResponse.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments).
  // `adapterVersion` is always included so dashboards / the runbook can
  // tell at a glance which version of the adapter produced a run —
  // critical during rollouts, hot-patches, and incident forensics where
  // stderr_excerpt may be truncated.
  const resultJson: Record<string, unknown> = {
    adapterVersion: ADAPTER_VERSION,
    result: cleanedResponse,
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // ── MCP telemetry → resultJson ────────────────────────────────────────
  // When the MCP tool server was used for this run, attach per-call
  // records + summary counters + subprocess health. This is the only
  // trustworthy record of which tools the LLM actually invoked — the
  // LLM's own `result` prose can (and occasionally does) lie about it.
  if (mcpTelemetry) {
    resultJson.toolCalls = mcpTelemetry.toolCalls;
    resultJson.toolCallCount = mcpTelemetry.toolCallCount;
    resultJson.toolErrorCount = mcpTelemetry.toolErrorCount;
    resultJson.mcpServerHealth = mcpTelemetry.health;

    await ctx.onLog(
      "stdout",
      `[hermes] mcp telemetry: calls=${mcpTelemetry.toolCallCount} ` +
        `errors=${mcpTelemetry.toolErrorCount} health=${mcpTelemetry.health.status}\n`,
    );

    // Flag runs where the MCP subprocess crashed mid-flight as a hard
    // failure so dashboards surface them (it's not a tool-call error,
    // it's the whole tool plane going away).
    if (mcpTelemetry.health.status === "died") {
      executionResult.errorCode = "tool_server_died";
      executionResult.errorMeta = {
        ...(executionResult.errorMeta || {}),
        mcpPid: mcpTelemetry.health.pid,
        mcpStartedAt: mcpTelemetry.health.startedAt,
        toolCallCountBeforeDeath: mcpTelemetry.toolCallCount,
      };
      executionResult.errorMessage =
        `paperclip-mcp subprocess (pid ${mcpTelemetry.health.pid}) died mid-run; ` +
        `tool calls after that point would have silently failed. ` +
        (executionResult.errorMessage ? `Also: ${executionResult.errorMessage}` : "");
    }
  }

  // ── Bypass detector → errorCode ───────────────────────────────────────
  // Even with MCP available, some LLMs will still construct curl calls
  // on v3 templates. We don't fail the run (many "bypasses" are legit:
  // e.g. curling an external news site) — we just annotate so dashboards
  // can track which agents ignore the rules.
  const bypass = scanForBypass(result.stdout || "", result.stderr || "");
  if (bypass.flagged) {
    resultJson.bypassFlagged = true;
    resultJson.bypassPatterns = bypass.matches;
    resultJson.bypassPrimary = bypass.primaryPattern;
    // Only set errorCode if the run would otherwise look successful —
    // we don't want bypass detection to mask a real error.
    if (!executionResult.errorCode) {
      executionResult.errorCode = "tool_bypass_attempt";
      executionResult.errorMeta = {
        ...(executionResult.errorMeta || {}),
        bypassPrimary: bypass.primaryPattern,
        bypassMatchCount: bypass.matches.length,
        bypassFirstSnippet: bypass.matches[0]?.snippet ?? null,
      };
    }
    await ctx.onLog(
      "stderr",
      `[hermes] bypass detected: ${bypass.matches.length} match(es), primary=${bypass.primaryPattern}\n`,
    );
  }

  executionResult.resultJson = resultJson;

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  // ── Post-run reconciliation ────────────────────────────────────────────
  // Two modes:
  //   1. adapter-owned-status template (builtin:mil-heartbeat-v2+): the
  //      LLM is instructed NOT to PATCH status itself. We parse the
  //      `RESULT:` marker from its final message and transition the
  //      issue ourselves, then post a structured completion comment.
  //      Defaults to 'done' if the marker is missing.
  //   2. Legacy template (builtin:mil-heartbeat, or caller-supplied):
  //      the LLM is still expected to emit status=done via curl. We
  //      just run the 0.3.2-mil.0 safety-net (patch done if still
  //      in_progress) to close the reconciler race window.
  //
  // Both paths only activate on a successful run with a taskId.
  //
  // `runSucceeded` intentionally trusts ONLY the process exit code and
  // timeout flag. `parsed.errorMessage` is diagnostic noise — Hermes and
  // its subprocess MCP tools emit benign "error"/"failed" keywords on
  // successful runs (MAR-27 regression), and letting that flip this guard
  // silently skipped reconcileOutcome and caused the issue to be marked
  // `blocked` by Paperclip's continuation retry.
  const runSucceeded = result.exitCode === 0 && !result.timedOut;

  if (runSucceeded && taskId && paperclipClient.apiKey) {
    if (adapterOwnedStatus) {
      const marker = parseResultMarker(parsed.response);
      const summary = cleanedResponse.slice(0, 2000);

      const finalOutcome = await reconcileOutcome({
        client: paperclipClient,
        taskId,
        agentName: ctx.agent?.name || "Hermes Agent",
        summary,
        marker,
        markerPresent: marker !== null,
      });

      // Reflect the parsed marker in the summary Paperclip stores on
      // the run record so UI/API consumers can see the agent's intent
      // without re-parsing the transcript.
      if (summary) {
        executionResult.summary = summary;
      }
      if (executionResult.resultJson && typeof executionResult.resultJson === "object") {
        (executionResult.resultJson as Record<string, unknown>).outcome = finalOutcome;
        (executionResult.resultJson as Record<string, unknown>).marker_present =
          marker !== null;
        if (marker?.reason) {
          (executionResult.resultJson as Record<string, unknown>).outcome_reason = marker.reason;
        }
      }
    } else {
      await ensureTerminalStatusSafetyNet(paperclipClient, taskId);
    }
  }

  return executionResult;
}
