/**
 * Test-mode override.
 *
 * Two activation paths, evaluated in priority order:
 *
 *   1. ENV (operator big-hammer, process-wide):
 *        PAPERCLIP_ADAPTER_TEST_MODE=1
 *      Set on the hermes ECS task definition. Every spawn in the
 *      process routes to the free model regardless of issue content.
 *      Reverts on next deploy when the env var is removed.
 *
 *   2. ISSUE (per-task, CEO-facing):
 *        <!-- mode: test -->          (explicit marker in body)
 *        "smoketest" / "test mode" /  (intent phrases in title or body)
 *        "low-cost validation"
 *      ONE specific issue runs in test mode; everything else stays on
 *      paid models. Sub-issues created during a test-mode run inherit
 *      the marker automatically (see mcp/tools/create-sub-issue.ts) so
 *      delegated work stays free too.
 *
 * Either path produces the same override:
 *   - main model      → free OpenRouter model (default openrouter/free)
 *   - provider        → openrouter
 *   - auxiliary slots → free OpenRouter model (compression / vision /
 *     session_search / title_generation)
 *
 * EXPLICITLY does NOT touch:
 *   - prompt template (still `builtin:mil-heartbeat-v3`)
 *   - per-agent role / department / skills
 *   - per-agent tool allowlist (`paperclipMcpTools`)
 *   - any other agent config
 *
 * Same company, same agents, same routines, same prompts — only the LLM
 * endpoint is swapped. That's the whole point: we want to validate that
 * the system behaves correctly end-to-end, and a free model is "good
 * enough" to follow tool-calling instructions on small synthetic tasks.
 *
 * Off by default. Verbose log on every spawn while active.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Default test model. We use OpenRouter's `openrouter/free` meta-router
 * because it filters its candidate pool to free models that support tool
 * calling and structured output — which is exactly what mil-heartbeat-v3
 * needs (the agent MUST call `mcp_paperclip_*` tools). Operators can
 * override with `PAPERCLIP_ADAPTER_TEST_MODEL` for a specific slug.
 */
export const DEFAULT_TEST_MODEL = "openrouter/free";

/**
 * Default test provider. Hardcoded to `openrouter` because every free
 * model worth using lives on OpenRouter and the company already has
 * `OPENROUTER_API_KEY` provisioned across all four hermes ECS task
 * definitions. Override with `PAPERCLIP_ADAPTER_TEST_PROVIDER` if needed.
 */
export const DEFAULT_TEST_PROVIDER = "openrouter";

/**
 * Auxiliary slots Hermes v0.11.0+ introduced. We force every slot to the
 * same free model so the test mode is truly free — otherwise compression
 * and session_search would silently fall back to the main model (which
 * test mode just overrode, so they'd inherit the free model anyway, but
 * being explicit avoids surprises if Hermes' default-fallback ever
 * changes again).
 */
const AUXILIARY_SLOTS = ["compression", "vision", "session_search", "title_generation"] as const;

/**
 * Where the test-mode activation came from. Used in diagnostic logging
 * so the operator can tell at-a-glance whether the override was the
 * env-var big-hammer or a CEO-driven per-issue smoketest.
 */
export type TestModeSource =
  | "env"
  | "issue-marker"
  | "issue-intent"
  | "inherited";

export interface TestModeConfig {
  active: boolean;
  /**
   * Where the activation came from. Only populated when `active === true`.
   */
  source?: TestModeSource;
  /**
   * Human-readable detail about the source — for env, the env-var name;
   * for issue-marker, the matched marker text; for issue-intent, the
   * matched phrase. Used in the activation banner.
   */
  sourceDetail?: string;
  /**
   * Source-of-truth env var snapshot at the moment we resolved the
   * config. Only populated when `active === true` AND `source === "env"`.
   * Useful for diagnostic logging — the operator can see *exactly* which
   * env vars produced the override without having to
   * `aws ecs execute-command env`.
   */
  rawEnv?: {
    PAPERCLIP_ADAPTER_TEST_MODE: string | undefined;
    PAPERCLIP_ADAPTER_TEST_MODEL: string | undefined;
    PAPERCLIP_ADAPTER_TEST_PROVIDER: string | undefined;
    PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: string | undefined;
  };
  model: string;
  provider: string;
  /**
   * Auxiliary slot config in the same shape `hermes-home.ts` expects.
   * Every slot is forced to `auxiliaryModel`.
   */
  auxiliary: Record<string, Record<string, unknown>>;
}

/**
 * Canonical issue-body marker. Recognised in either of these forms:
 *   <!-- mode: test -->
 *   <!-- mode:test -->
 *   <!-- MODE: TEST -->
 *
 * White-space-tolerant. Match is single-line; multi-line HTML comments
 * are not currently supported (no use case).
 */
const ISSUE_MARKER_REGEX = /<!--\s*mode\s*:\s*test\s*-->/i;

/**
 * Natural-language intent phrases. Word-boundary anchored, case
 * insensitive. Deliberately conservative — we'd rather miss a real
 * test-mode intent than flip a production issue to free models because
 * "test" appeared in the body for an unrelated reason ("test the
 * hypothesis that…", "QA test this approach", etc.).
 *
 * The phrases below are the ones *we* (operators) tell the CEO to use:
 *   - "smoketest" / "smoke test" / "smoke-test"
 *   - "test mode"
 *   - "low-cost validation"
 *   - "test flow"
 *
 * Add to this list cautiously. Each new phrase increases the false-
 * positive surface, so prefer steering CEO prompts to use one of the
 * existing phrases (or the explicit `<!-- mode: test -->` marker, which
 * has zero false-positive risk).
 */
const INTENT_PATTERNS: Array<{ regex: RegExp; phrase: string }> = [
  { regex: /\bsmoke[\s-]?test(?:ing|s)?\b/i, phrase: "smoketest" },
  { regex: /\btest\s+mode\b/i, phrase: "test mode" },
  { regex: /\blow[\s-]?cost\s+validation\b/i, phrase: "low-cost validation" },
  { regex: /\btest\s+flow\b/i, phrase: "test flow" },
];

export interface IssueModeProbe {
  active: boolean;
  source?: "issue-marker" | "issue-intent";
  sourceDetail?: string;
}

/**
 * Inspect issue title + body for explicit or implicit test-mode intent.
 * Pure function — no env, no I/O. The result is combined with env-mode
 * by `resolveTestMode` (env wins on conflicts).
 */
export function probeIssueMode(args: {
  title?: string | null;
  body?: string | null;
}): IssueModeProbe {
  const title = (args.title ?? "").trim();
  const body = (args.body ?? "").trim();

  // Explicit marker beats intent — operators / parents can use it to
  // force test mode in an issue whose title/body doesn't naturally
  // mention smoketests.
  const markerMatch = body.match(ISSUE_MARKER_REGEX) || title.match(ISSUE_MARKER_REGEX);
  if (markerMatch) {
    return {
      active: true,
      source: "issue-marker",
      sourceDetail: markerMatch[0],
    };
  }

  for (const { regex, phrase } of INTENT_PATTERNS) {
    if (regex.test(title)) {
      return { active: true, source: "issue-intent", sourceDetail: `title: ${phrase}` };
    }
    if (regex.test(body)) {
      return { active: true, source: "issue-intent", sourceDetail: `body: ${phrase}` };
    }
  }

  return { active: false };
}

export function isTestModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PAPERCLIP_ADAPTER_TEST_MODE;
  if (!v) return false;
  return TRUTHY.has(String(v).trim().toLowerCase());
}

function buildOverridePayload(
  env: NodeJS.ProcessEnv,
): Pick<TestModeConfig, "model" | "provider" | "auxiliary"> {
  const model = (env.PAPERCLIP_ADAPTER_TEST_MODEL || DEFAULT_TEST_MODEL).trim();
  const provider = (env.PAPERCLIP_ADAPTER_TEST_PROVIDER || DEFAULT_TEST_PROVIDER).trim();
  const auxModel = (env.PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL || model).trim();

  const auxiliary: Record<string, Record<string, unknown>> = {};
  for (const slot of AUXILIARY_SLOTS) {
    auxiliary[slot] = { model: auxModel, provider };
  }

  return { model, provider, auxiliary };
}

/**
 * Backwards-compatible entry point: returns the env-only resolution.
 * Equivalent to `resolveTestMode({env})` with no issue context. Kept
 * because external callers and existing tests rely on the same shape.
 */
export function resolveTestModeConfig(env: NodeJS.ProcessEnv = process.env): TestModeConfig {
  return resolveTestMode({ env });
}

/**
 * Combined resolution. Inputs:
 *   env   — process env (for the operator big-hammer flag)
 *   title — issue title (for per-issue intent / marker)
 *   body  — issue body  (for per-issue intent / marker)
 *
 * Priority: env > issue-marker > issue-intent > prod.
 *
 * Env wins because the operator big-hammer is what we use to force
 * test mode globally during an infra incident — any per-issue prod
 * intent during that period must yield to it. The other two sources
 * differ only in diagnostic detail; they produce the same overrides.
 */
export function resolveTestMode(args: {
  env?: NodeJS.ProcessEnv;
  title?: string | null;
  body?: string | null;
}): TestModeConfig {
  const env = args.env ?? process.env;

  if (isTestModeActive(env)) {
    return {
      active: true,
      source: "env",
      sourceDetail: `PAPERCLIP_ADAPTER_TEST_MODE=${env.PAPERCLIP_ADAPTER_TEST_MODE}`,
      rawEnv: {
        PAPERCLIP_ADAPTER_TEST_MODE: env.PAPERCLIP_ADAPTER_TEST_MODE,
        PAPERCLIP_ADAPTER_TEST_MODEL: env.PAPERCLIP_ADAPTER_TEST_MODEL,
        PAPERCLIP_ADAPTER_TEST_PROVIDER: env.PAPERCLIP_ADAPTER_TEST_PROVIDER,
        PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: env.PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL,
      },
      ...buildOverridePayload(env),
    };
  }

  const probe = probeIssueMode({ title: args.title, body: args.body });
  if (probe.active) {
    return {
      active: true,
      source: probe.source,
      sourceDetail: probe.sourceDetail,
      ...buildOverridePayload(env),
    };
  }

  return {
    active: false,
    model: "",
    provider: "",
    auxiliary: {},
  };
}

/**
 * Format the loud "TEST MODE ACTIVE" log line emitted at the top of
 * every spawn. We deliberately surface BOTH the original (configured)
 * model/provider AND the overrides so a single grep on production logs
 * tells an operator (a) test mode is on, (b) which agent's config was
 * used as the base, and (c) where the activation came from (env-var
 * big-hammer vs CEO-driven per-issue smoketest vs inherited from a
 * test-mode parent).
 */
export function formatTestModeBanner(args: {
  cfg: TestModeConfig;
  originalModel: string;
  originalProvider: string;
  agentName?: string | null;
}): string {
  const { cfg, originalModel, originalProvider, agentName } = args;
  if (!cfg.active) return "";
  const who = agentName ? ` agent=${agentName}` : "";
  const sourceTag = cfg.source ? `source=${cfg.source}` : "source=unknown";
  const detail = cfg.sourceDetail ? ` detail="${cfg.sourceDetail}"` : "";
  return (
    `[hermes] *** TEST MODE ACTIVE ***${who} ` +
    `model=${originalModel || "(default)"}->${cfg.model} ` +
    `provider=${originalProvider || "(auto)"}->${cfg.provider} ` +
    `auxiliary=*->${(cfg.auxiliary.compression?.model as string) ?? cfg.model} ` +
    `${sourceTag}${detail}\n`
  );
}
