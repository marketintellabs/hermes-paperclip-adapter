/**
 * OpenRouter model mode.
 *
 * A process-wide, env-controlled toggle that maps each agent's *tier* to a
 * concrete model based on the active mode. It generalises the binary
 * `test-mode.ts` override (free vs paid) into three named modes so the
 * fleet can be run cheaply for evaluation without editing every agent's
 * `adapterConfig.model` in the Paperclip DB.
 *
 *   OPENROUTER_MODE = production | hybrid | free_only      (default: production)
 *
 *   production  — identity. Every agent runs its configured paid model.
 *                 This is the default; deploying the feature changes nothing
 *                 until an operator flips the env var and redeploys.
 *   hybrid      — keep the expensive reasoning/writing tiers paid
 *                 (opus, quality, glm) and route the high-volume worker tiers
 *                 (super, nano) to a free model. The cost-saving sweet spot.
 *   free_only   — every tier routes to the free model. Dev / full-system
 *                 validation only; will degrade on rate limits.
 *
 * The free model defaults to OpenRouter's `openrouter/free` meta-router
 * (same as test mode) because it filters its candidate pool to free models
 * that support tool calling + structured output — exactly what the
 * mil-heartbeat templates need. It is overridable AT RUNTIME via the
 * `OPENROUTER_FREE_MODEL` env var (set on the ECS task definition; no adapter
 * rebuild required) so an operator can pin a specific free slug or an
 * alternative meta-router if `openrouter/free` is having issues.
 *
 * Precedence (resolved in execute.ts): test-mode (env big-hammer or per-issue
 * marker) WINS over OPENROUTER_MODE, which in turn wins over the configured
 * paid model. So smoketest routing is never disturbed by the mode toggle.
 *
 * This module is intentionally a pure function of (env, tier, configured
 * model/provider) with no I/O, mirroring `test-mode.ts`.
 */

export type OpenRouterMode = "production" | "hybrid" | "free_only";

const VALID_MODES: ReadonlySet<string> = new Set([
  "production",
  "hybrid",
  "free_only",
]);

/**
 * Default free model. `openrouter/free` is OpenRouter's meta-router over the
 * free tool-calling pool — robust to any single free model being deprecated
 * or saturated. Override per-deploy with `OPENROUTER_FREE_MODEL`.
 */
export const DEFAULT_FREE_MODEL = "openrouter/free";

/** Provider for the free model. Every free model worth using is on OpenRouter. */
export const FREE_PROVIDER = "openrouter";

/**
 * Auxiliary slots (Hermes v0.11.0+). When a tier is freed we force every slot
 * to the same free model so the run is genuinely free — matching test-mode's
 * behaviour exactly.
 */
const AUXILIARY_SLOTS = [
  "compression",
  "vision",
  "session_search",
  "title_generation",
] as const;

/**
 * Which agent tiers are routed to the free model in each mode. Tiers are the
 * MIL template aliases written to `adapterConfig.modelTier` by
 * `paperclip/configure-agents.mjs` (opus / quality / super / nano / glm).
 *
 * hybrid frees only the high-volume worker tiers (super, nano); the reasoning
 * and long-form writing/review tiers (opus, quality, glm) stay paid because
 * that's where free-model quality degradation hurts most. free_only frees
 * everything.
 */
const FREE_TIERS_BY_MODE: Record<OpenRouterMode, ReadonlySet<string>> = {
  production: new Set(),
  hybrid: new Set(["super", "nano"]),
  free_only: new Set(["opus", "quality", "super", "nano", "glm"]),
};

/**
 * Parse the `OPENROUTER_MODE` env var. Unknown / empty values resolve to
 * `production` (fail safe — never silently downgrade to free), and the
 * `recognized` flag lets the caller log a warning on a typo'd value.
 */
export function parseOpenRouterMode(raw: string | undefined): {
  mode: OpenRouterMode;
  recognized: boolean;
} {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return { mode: "production", recognized: true };
  if (VALID_MODES.has(v)) return { mode: v as OpenRouterMode, recognized: true };
  return { mode: "production", recognized: false };
}

export function resolveOpenRouterMode(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterMode {
  return parseOpenRouterMode(env.OPENROUTER_MODE).mode;
}

export function resolveFreeModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENROUTER_FREE_MODEL || DEFAULT_FREE_MODEL).trim();
}

export interface ModelModeResolution {
  /** Active mode after parsing OPENROUTER_MODE. */
  mode: OpenRouterMode;
  /** Whether OPENROUTER_MODE held an unrecognised value (caller may warn). */
  recognized: boolean;
  /** Agent tier used for the decision (normalised), or null if not provided. */
  tier: string | null;
  /**
   * True when this run's model is being changed from its configured value
   * (i.e. the tier is freed in the active mode). When false, the caller must
   * use the configured model + configured auxiliary unchanged.
   */
  overridden: boolean;
  /** Effective model: the free model when overridden, else the configured model. */
  model: string;
  /** Effective provider. */
  provider: string;
  /**
   * Auxiliary slot config (same shape `hermes-home.ts` expects), every slot
   * forced to the free model. Empty when not overridden (caller falls back to
   * the agent's configured auxiliaryModels).
   */
  auxiliary: Record<string, Record<string, unknown>>;
}

/**
 * Resolve the model/provider/auxiliary for a run under the active mode.
 *
 * Pure: depends only on its inputs. The caller (execute.ts) is responsible
 * for precedence (test-mode wins) and for sourcing `tier` from
 * `adapterConfig.modelTier`.
 *
 * Safety: in `hybrid`, a missing/unknown tier is treated as NOT-freed (stays
 * on the configured paid model) so we can never accidentally downgrade a
 * reasoning agent whose tier wasn't set. `free_only` frees regardless of
 * tier (the whole point is everything-free).
 */
export function resolveModelMode(args: {
  env?: NodeJS.ProcessEnv;
  tier?: string | null;
  configuredModel: string;
  configuredProvider?: string | null;
}): ModelModeResolution {
  const env = args.env ?? process.env;
  const { mode, recognized } = parseOpenRouterMode(env.OPENROUTER_MODE);
  const tier = (args.tier ?? "").trim().toLowerCase() || null;
  const configuredProvider = (args.configuredProvider ?? "").trim();

  const freeTiers = FREE_TIERS_BY_MODE[mode];
  const freed =
    mode === "free_only"
      ? true
      : tier !== null && freeTiers.has(tier);

  if (!freed) {
    return {
      mode,
      recognized,
      tier,
      overridden: false,
      model: args.configuredModel,
      provider: configuredProvider,
      auxiliary: {},
    };
  }

  const freeModel = resolveFreeModel(env);
  const auxiliary: Record<string, Record<string, unknown>> = {};
  for (const slot of AUXILIARY_SLOTS) {
    auxiliary[slot] = { model: freeModel, provider: FREE_PROVIDER };
  }

  return {
    mode,
    recognized,
    tier,
    overridden: true,
    model: freeModel,
    provider: FREE_PROVIDER,
    auxiliary,
  };
}

/**
 * Per-spawn banner emitted when a run's model was changed by the mode policy.
 * Mirrors `formatTestModeBanner` so a single grep surfaces both. Includes the
 * tier and the original->effective model so cost analysis can group by model.
 */
export function formatModeBanner(args: {
  res: ModelModeResolution;
  originalModel: string;
  originalProvider: string;
  agentName?: string | null;
}): string {
  const { res, originalModel, originalProvider, agentName } = args;
  if (!res.overridden) return "";
  const who = agentName ? ` agent=${agentName}` : "";
  const aux = (res.auxiliary.compression?.model as string) ?? res.model;
  return (
    `[hermes] *** OPENROUTER_MODE=${res.mode} ***${who} ` +
    `tier=${res.tier ?? "(unset)"} ` +
    `model=${originalModel || "(default)"}->${res.model} ` +
    `provider=${originalProvider || "(auto)"}->${res.provider} ` +
    `auxiliary=*->${aux}\n`
  );
}
