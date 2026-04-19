/**
 * Shared constants for the Hermes Agent adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/** Default CLI binary name. */
export const HERMES_CLI = "hermes";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Default model to use if none specified. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

/**
 * Valid --provider choices for the hermes CLI.
 * Must stay in sync with `hermes chat --help`.
 */
export const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

/**
 * Model-name prefix → provider hint mapping.
 * Used when no explicit provider is configured and we need to infer
 * the correct provider from the model string alone.
 *
 * Keys are lowercased prefix patterns; values must be valid provider names.
 * Longer prefixes are matched first (order matters).
 */
export const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  // OpenAI-native models
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  // Anthropic models
  ["claude", "anthropic"],
  // Google models (via openrouter or direct)
  ["gemini", "auto"],
  // Nous models
  ["hermes-", "nous"],
  // Z.AI / GLM models
  ["glm-", "zai"],
  // Kimi / Moonshot
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  // MiniMax
  ["minimax", "minimax"],
  // DeepSeek
  ["deepseek", "auto"],
  // Meta Llama
  ["llama", "auto"],
  // Qwen
  ["qwen", "auto"],
  // Mistral
  ["mistral", "auto"],
  // HuggingFace models (org/model format)
  ["huggingface/", "huggingface"],
  // ── MarketIntelLabs fork additions ─────────────────────────────────────
  // OpenRouter model-ID conventions: when the model is given in the
  // `<org>/<model>` form that OpenRouter uses, route through OpenRouter
  // directly. Keep these BELOW the single-vendor hints above so explicit
  // anthropic/openai/z.ai detection still wins for non-OpenRouter setups.
  ["anthropic/", "openrouter"],
  ["openai/", "openrouter"],
  ["x-ai/", "openrouter"],
  ["zai-org/", "openrouter"],
  ["google/", "openrouter"],
  ["meta-llama/", "openrouter"],
  ["deepseek/", "openrouter"],
  ["mistralai/", "openrouter"],
  ["qwen/", "openrouter"],
];

/**
 * Builtin prompt template identifiers (MarketIntelLabs fork).
 * Consumers can set `adapterConfig.promptTemplate = "builtin:<name>"`
 * to use a template shipped with the package instead of embedding a
 * giant string in their adapter config.
 */
/**
 * Known builtin template names.
 *
 *   `mil-heartbeat`     — legacy template (pre-0.4.0). Status transitions
 *                         are delegated to the LLM via curl. Kept for
 *                         backcompat with agents that have not yet been
 *                         re-configured.
 *   `mil-heartbeat-v2`  — adapter-owned status template (0.4.0+). Status
 *                         transitions are handled by the adapter; the LLM
 *                         signals outcome via a `RESULT:` marker at the
 *                         end of its final message. See
 *                         `src/server/result-marker.ts`. Still instructs
 *                         the LLM to interact with Paperclip via curl.
 *   `mil-heartbeat-v3`  — MCP-tool template (0.7.0+). Same adapter-owned
 *                         status semantics as v2, but strips all curl /
 *                         API-reference instructions and mandates the
 *                         LLM use the in-process `paperclip-mcp` tool
 *                         server instead. See `templates/mil-heartbeat-v3.md`
 *                         and `src/mcp/`.
 */
export const BUILTIN_PROMPT_TEMPLATES = [
  "mil-heartbeat",
  "mil-heartbeat-v2",
  "mil-heartbeat-v3",
] as const;
export const BUILTIN_PROMPT_TEMPLATE_PREFIX = "builtin:";

/**
 * Template names that opt into adapter-owned status transitions.
 *
 * When the resolved promptTemplate is one of these, the adapter will:
 *   - PATCH the issue to `in_progress` before spawning Hermes (if it
 *     isn't already).
 *   - Parse the RESULT marker from Hermes output after a successful run.
 *   - PATCH the issue to the marker's outcome (`done` / `blocked` /
 *     `cancelled`) and POST a structured completion comment.
 *
 * Templates not in this set retain the pre-0.4.0 behaviour: the adapter
 * only runs a safety-net reconciliation if a successful run left the
 * issue in `todo`/`in_progress` (the 0.3.2-mil.0 fix).
 */
export const ADAPTER_OWNED_STATUS_TEMPLATES = new Set<string>([
  "mil-heartbeat-v2",
  "mil-heartbeat-v3",
]);

/**
 * Template names that require the in-process Paperclip MCP tool server
 * (`paperclip-mcp`) to be registered in the per-run HERMES_HOME's
 * `config.yaml`. When the resolved template is in this set, `execute.ts`
 * builds a per-run HERMES_HOME with the `mcp_servers.paperclip` block
 * baked in (carrying the run's authToken + scope via env), and spawns
 * hermes with `HERMES_HOME` pointing at it.
 *
 * Kept separate from `ADAPTER_OWNED_STATUS_TEMPLATES` so future templates
 * can opt into MCP without adopting the RESULT-marker flow, or vice
 * versa.
 */
export const MCP_TOOL_TEMPLATES = new Set<string>([
  "mil-heartbeat-v3",
]);

/** Regex to extract session ID from Hermes CLI output. */
export const SESSION_ID_REGEX = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/** Prefix used by Hermes for tool output lines. */
export const TOOL_OUTPUT_PREFIX = "┊";

/** Prefix for Hermes thinking blocks. */
export const THINKING_PREFIX = "💭";
