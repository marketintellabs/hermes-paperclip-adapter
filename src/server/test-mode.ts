/**
 * Test-mode override.
 *
 * When the operator sets `PAPERCLIP_ADAPTER_TEST_MODE=1` (or `true`/`yes`),
 * the adapter ignores the agent's configured `model` / `provider` /
 * `auxiliaryModels` and substitutes a free OpenRouter model for the
 * duration of every spawn in this process. This lets us exercise the full
 * scheduling + MCP + reconciliation path against the real production
 * Paperclip company without burning paid OpenRouter credits.
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

export interface TestModeConfig {
  active: boolean;
  /**
   * Source-of-truth env var snapshot at the moment we resolved the
   * config. Only populated when `active === true`. Useful for diagnostic
   * logging — the operator can see *exactly* which env vars produced the
   * override without having to `aws ecs execute-command env`.
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

export function isTestModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PAPERCLIP_ADAPTER_TEST_MODE;
  if (!v) return false;
  return TRUTHY.has(String(v).trim().toLowerCase());
}

export function resolveTestModeConfig(env: NodeJS.ProcessEnv = process.env): TestModeConfig {
  if (!isTestModeActive(env)) {
    return {
      active: false,
      model: "",
      provider: "",
      auxiliary: {},
    };
  }

  const model = (env.PAPERCLIP_ADAPTER_TEST_MODEL || DEFAULT_TEST_MODEL).trim();
  const provider = (env.PAPERCLIP_ADAPTER_TEST_PROVIDER || DEFAULT_TEST_PROVIDER).trim();
  const auxModel = (env.PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL || model).trim();

  const auxiliary: Record<string, Record<string, unknown>> = {};
  for (const slot of AUXILIARY_SLOTS) {
    auxiliary[slot] = { model: auxModel, provider };
  }

  return {
    active: true,
    rawEnv: {
      PAPERCLIP_ADAPTER_TEST_MODE: env.PAPERCLIP_ADAPTER_TEST_MODE,
      PAPERCLIP_ADAPTER_TEST_MODEL: env.PAPERCLIP_ADAPTER_TEST_MODEL,
      PAPERCLIP_ADAPTER_TEST_PROVIDER: env.PAPERCLIP_ADAPTER_TEST_PROVIDER,
      PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL: env.PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL,
    },
    model,
    provider,
    auxiliary,
  };
}

/**
 * Format the loud "TEST MODE ACTIVE" log line emitted at the top of
 * every spawn. We deliberately surface BOTH the original (configured)
 * model/provider AND the overrides so a single grep on production logs
 * tells an operator (a) test mode is on and (b) which agent's config
 * was being used as the base.
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
  return (
    `[hermes] *** TEST MODE ACTIVE ***${who} ` +
    `model=${originalModel || "(default)"}->${cfg.model} ` +
    `provider=${originalProvider || "(auto)"}->${cfg.provider} ` +
    `auxiliary=*->${(cfg.auxiliary.compression?.model as string) ?? cfg.model} ` +
    `(set by PAPERCLIP_ADAPTER_TEST_MODE=${cfg.rawEnv?.PAPERCLIP_ADAPTER_TEST_MODE})\n`
  );
}
