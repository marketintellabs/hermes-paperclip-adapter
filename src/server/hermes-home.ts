/**
 * Per-run HERMES_HOME construction.
 *
 * Hermes reads its config from `$HERMES_HOME/config.yaml` (see
 * hermes_constants.get_hermes_home in the upstream repo). The `mcp_servers`
 * block is static in that file — whatever env vars you write into it are
 * fixed for the life of the hermes process.
 *
 * Each adapter run has a DIFFERENT scope: different agent, different
 * JWT authToken, different assigned issueId. If we wrote the mcp_servers
 * block into the shared `~/.hermes/config.yaml` per-run, two concurrent
 * runs on the same container would clobber each other's scope (multiple
 * agents share a department container, e.g. hermes-publishing-production).
 *
 * This module builds a per-run, isolated HERMES_HOME directory:
 *   /tmp/paperclip-run-<runId>/
 *     config.yaml      — fresh (base + per-run mcp_servers block)
 *     .env            -> symlink to ~/.hermes/.env
 *     sessions/       -> symlink to ~/.hermes/sessions  (preserves resume)
 *     skills/         -> symlink to ~/.hermes/skills
 *     logs/           -> symlink to ~/.hermes/logs
 *     …and everything else in ~/.hermes, linked through
 *
 * The adapter spawns hermes with HERMES_HOME pointing at this dir. Hermes
 * sees a single coherent home with its own config.yaml; reads/writes for
 * sessions and logs transparently flow to the real ~/.hermes via the
 * symlinks. After the run we rm -rf the temp dir — the symlinks break
 * but the targets survive.
 *
 * If the real home doesn't exist (e.g. local tests), we still produce a
 * minimal working HERMES_HOME with just the config.yaml. Hermes will
 * create sessions/logs on demand inside the temp dir.
 */

import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Per-agent override for Hermes' auxiliary-task models.
 *
 * Hermes makes background LLM calls outside the main agent loop for
 * `compression` (context summarisation), `vision` (image parsing),
 * `session_search` (hindsight retrieval), and `title_generation`
 * (auto-naming new sessions). Hermes >= v2026.4.23 ("v0.11.0") changed
 * the default from "use a cheap aggregator-side model" to "use the
 * main model" — which silently regresses cost for OpenRouter / Nous
 * Portal users when the main model is something expensive like
 * Claude Opus or grok-4.
 *
 * This field is the per-agent escape hatch. Each top-level key is a
 * Hermes auxiliary slot name; the value is an arbitrary YAML object
 * passed through verbatim to the per-run `config.yaml` `auxiliary:`
 * block. Most callers will use `{ provider, model }` per slot, but
 * the shape is intentionally open so a future Hermes that adds
 * `temperature`, `max_tokens`, or a new auxiliary slot doesn't
 * require an adapter change.
 *
 * Effect is a no-op against Hermes < v2026.4.23 (those versions
 * ignore the `auxiliary:` block entirely). Setting this on
 * `adapterConfig` is therefore safe to roll out before the Hermes
 * upgrade — the override kicks in automatically once Hermes is
 * bumped.
 *
 * Example:
 *
 *     auxiliaryModels:
 *       compression:
 *         provider: openrouter
 *         model: meta-llama/llama-3.1-8b-instruct
 *       title_generation:
 *         provider: openrouter
 *         model: meta-llama/llama-3.1-8b-instruct
 *
 * Slots NOT named in this map fall back to whatever the operator
 * has in `~/.hermes/config.yaml` (or, absent that, Hermes' built-in
 * default). Slot-level merge — setting `compression` here does not
 * stomp the operator's `vision` setting.
 */
export type AuxiliaryModelsConfig = Record<string, Record<string, unknown>>;

/**
 * Per-run Paperclip MCP scope. All fields except `apiUrl` + `apiKey`
 * are optional — missing ones just won't appear in the env block.
 * The MCP server handles absence gracefully (reads fail with a clear
 * "not set" error rather than hallucinating).
 */
export interface PaperclipMcpScope {
  apiUrl: string;
  apiKey: string;
  agentId?: string | null;
  companyId?: string | null;
  issueId?: string | null;
  runId?: string | null;
  /**
   * Per-agent MCP tool allowlist. When set, the MCP server registers
   * only these tools (see `src/mcp/server.ts` resolveToolsToRegister).
   * Passed through to the MCP subprocess as the
   * `PAPERCLIP_MCP_TOOLS=<comma,separated>` env var; Hermes' own safe-env
   * filter strips most of the parent env, so we have to bake this into
   * the config.yaml mcp_servers.paperclip.env block explicitly.
   *
   * `null` / `undefined` = no allowlist (register every tool, 0.8.6
   * backward-compatible behaviour). `[]` = register nothing (valid but
   * pointless; ops use case is "read-only audit agent").
   */
  allowedTools?: readonly string[] | null;
  /**
   * Per-agent override for Hermes' auxiliary-task models. See
   * {@link AuxiliaryModelsConfig} for the rationale and shape.
   * Absent / null / `{}` = adapter writes no `auxiliary:` block,
   * Hermes' default behaviour applies (which on >= v2026.4.23 means
   * "use the main model for every auxiliary task" — potentially
   * expensive).
   */
  auxiliaryModels?: AuxiliaryModelsConfig | null;
  /**
   * Test-mode signal for the MCP subprocess. When `active === true` the
   * adapter sets `PAPERCLIP_TEST_MODE=1` (plus `_SOURCE`) on the
   * mcp_servers.paperclip.env block so the MCP server's
   * `create_sub_issue` tool can see it and prepend the inheritance
   * marker `<!-- mode: test (inherited from parent) -->` to the
   * sub-issue body. That way a sub-agent waking on the new issue
   * detects test mode via its own body probe and inherits the override
   * without any cross-process channel beyond the issue text itself —
   * which is also what the operator sees in the Paperclip UI.
   */
  testMode?: {
    active: boolean;
    source?: string;
    sourceDetail?: string;
  } | null;
}

export interface PerRunHermesHome {
  /** Absolute path to the temp dir that should be set as `HERMES_HOME`. */
  path: string;
  /**
   * Absolute path to the NDJSON audit file the MCP server appends to
   * for every completed tool call. The adapter reads this post-run
   * and surfaces the records as `resultJson.toolCalls`. File may not
   * exist if no tool calls happened.
   */
  auditLogPath: string;
  /**
   * Absolute path to the MCP server's liveness file. Present while the
   * MCP child is alive, deleted on clean shutdown. The adapter inspects
   * this post-run to detect MCP processes that died unexpectedly
   * (OOM, uncaughtException) — those get flagged errorCode=tool_server_died.
   */
  livenessFilePath: string;
  /** Async cleanup — call from a try/finally around the hermes spawn. */
  cleanup: () => Promise<void>;
}

/**
 * Compute the absolute path to the compiled MCP CLI bin shipped in this
 * package. Used as the `command`/`args[0]` in the mcp_servers block.
 *
 * Resolves from `dist/server/hermes-home.js` → `dist/mcp/cli.js` so it
 * works identically in the installed npm layout
 * (`node_modules/@marketintellabs/hermes-paperclip-adapter/dist/...`)
 * and the in-repo test layout.
 */
export function resolveMcpCliPath(): string {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  return join(hereDir, "..", "mcp", "cli.js");
}

/**
 * Extra paths the adapter passes to the MCP server so it can write
 * telemetry (audit trail + liveness marker) that execute.ts collects
 * post-run. All absolute paths; optional — missing fields just disable
 * the corresponding feature in the MCP server.
 */
export interface McpTelemetryPaths {
  /** NDJSON sink for per-call audit records. */
  auditLogPath?: string;
  /** Liveness PID file (present while alive, removed on clean exit). */
  livenessFilePath?: string;
}

/**
 * Build the mcp_servers.paperclip block as a plain JS object. Split out
 * so tests can assert on it without file-system side effects.
 */
export function buildMcpServerSpec(
  scope: PaperclipMcpScope,
  mcpCliPath: string = resolveMcpCliPath(),
  telemetry: McpTelemetryPaths = {},
): Record<string, unknown> {
  const env: Record<string, string> = {
    PAPERCLIP_API_URL: scope.apiUrl,
    PAPERCLIP_API_KEY: scope.apiKey,
  };
  if (scope.agentId) env.PAPERCLIP_AGENT_ID = scope.agentId;
  if (scope.companyId) env.PAPERCLIP_COMPANY_ID = scope.companyId;
  if (scope.issueId) env.PAPERCLIP_ISSUE_ID = scope.issueId;
  if (scope.runId) env.PAPERCLIP_RUN_ID = scope.runId;
  if (telemetry.auditLogPath) env.PAPERCLIP_MCP_AUDIT_LOG = telemetry.auditLogPath;
  if (telemetry.livenessFilePath) env.PAPERCLIP_MCP_LIVENESS_FILE = telemetry.livenessFilePath;
  // Per-agent MCP tool allowlist. Serialized as a comma-separated list
  // because the MCP subprocess reads a single env var. We only emit
  // the var when allowedTools is an array — leaving it unset means
  // "register every tool" in the MCP server.
  if (Array.isArray(scope.allowedTools)) {
    env.PAPERCLIP_MCP_TOOLS = scope.allowedTools.join(",");
  }
  // Test-mode signal for cross-issue inheritance. The MCP server's
  // create_sub_issue handler reads PAPERCLIP_TEST_MODE and, when set,
  // prepends a marker to the sub-issue body so the woken sub-agent
  // inherits test mode via its own body probe. _SOURCE is informational
  // (audit log clarity); only PAPERCLIP_TEST_MODE flips behaviour.
  if (scope.testMode?.active) {
    env.PAPERCLIP_TEST_MODE = "1";
    if (scope.testMode.source) {
      env.PAPERCLIP_TEST_MODE_SOURCE = scope.testMode.source;
    }
    if (scope.testMode.sourceDetail) {
      env.PAPERCLIP_TEST_MODE_SOURCE_DETAIL = scope.testMode.sourceDetail;
    }
  }

  return {
    command: "node",
    args: [mcpCliPath],
    env,
    enabled: true,
    // Utility tools (list_resources / list_prompts) would be dead weight —
    // we don't expose resources or prompts, only tools.
    tools: { resources: false, prompts: false },
  };
}

/**
 * Slot-level merge of an auxiliary-models override into the existing
 * `auxiliary:` block from a parsed base config. Per-agent overrides
 * win at the slot level — so an adapterConfig that sets only
 * `compression` does not stomp the operator's `vision` setting from
 * `~/.hermes/config.yaml`.
 *
 * Returns the merged auxiliary block, or `undefined` if neither side
 * had anything to contribute (caller should NOT add an empty
 * `auxiliary:` key in that case — Hermes treats present-but-empty as
 * "deny all auxiliary calls" on some versions).
 *
 * Exported for unit testing.
 */
export function mergeAuxiliaryConfig(
  base: Record<string, unknown> | undefined,
  override: AuxiliaryModelsConfig | null | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  if (base && typeof base === "object") {
    for (const [slot, value] of Object.entries(base)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[slot] = { ...(value as Record<string, unknown>) };
      }
    }
  }
  if (override && typeof override === "object") {
    for (const [slot, value] of Object.entries(override)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      // Per-agent override wins at the slot level; non-object values
      // are silently skipped (defensive — adapterConfig comes from
      // operator-edited JSON).
      out[slot] = { ...(value as Record<string, unknown>) };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge a Paperclip MCP scope into a base Hermes config YAML string.
 * Preserves any other `mcp_servers.<name>` entries the operator has
 * added (gmail, github, etc.) and overwrites only the `paperclip` entry.
 *
 * Also merges an `auxiliary:` block from `scope.auxiliaryModels`
 * (per-agent override) into whatever was already in the base
 * config.yaml's `auxiliary:` block (operator-global override). Slot-
 * level merge — see {@link mergeAuxiliaryConfig}.
 *
 * Exported for unit testing — production callers use
 * {@link buildPerRunHermesHome} which reads/writes the file.
 */
export function mergeMcpServerIntoConfig(
  baseConfigYaml: string,
  scope: PaperclipMcpScope,
  mcpCliPath: string = resolveMcpCliPath(),
  telemetry: McpTelemetryPaths = {},
): string {
  const parsed = (baseConfigYaml.trim() ? parseYaml(baseConfigYaml) : {}) as
    | Record<string, unknown>
    | null;
  const base: Record<string, unknown> = parsed && typeof parsed === "object" ? parsed : {};

  const existing = (base.mcp_servers as Record<string, unknown> | undefined) ?? {};
  base.mcp_servers = {
    ...existing,
    paperclip: buildMcpServerSpec(scope, mcpCliPath, telemetry),
  };

  const mergedAuxiliary = mergeAuxiliaryConfig(
    base.auxiliary as Record<string, unknown> | undefined,
    scope.auxiliaryModels ?? null,
  );
  if (mergedAuxiliary) {
    base.auxiliary = mergedAuxiliary;
  }
  // If both base and override were absent, leave `auxiliary` untouched
  // (could be `undefined` already, or could be set in the base YAML to
  // some non-object the operator wants preserved as-is).

  return stringifyYaml(base, { lineWidth: 0 });
}

/**
 * Build a per-run HERMES_HOME directory with the paperclip MCP scope
 * baked into config.yaml. Return the path + cleanup.
 *
 * Idempotent on re-entry: if somehow called with a runId that already
 * has a temp dir, we reuse it (rewrite config.yaml, rebuild symlinks
 * that are missing).
 */
export async function buildPerRunHermesHome(
  runId: string,
  scope: PaperclipMcpScope,
  opts: { realHome?: string; mcpCliPath?: string } = {},
): Promise<PerRunHermesHome> {
  const realHome = opts.realHome ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  const safeRunId = sanitizeRunId(runId);

  // Distinct per-run dir. Using mkdtemp would give us a unique suffix
  // but makes cleanup on retry harder; a predictable name by runId is
  // more debuggable and collisions are impossible (runIds are unique).
  const path = await mkdtemp(join(tmpdir(), `paperclip-run-${safeRunId}-`));

  // Symlink all entries except config.yaml so sessions, skills, .env,
  // and everything else route to the real home.
  if (existsSync(realHome)) {
    const entries = await readdir(realHome, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "config.yaml") continue;
      const target = join(realHome, entry.name);
      const link = join(path, entry.name);
      try {
        await symlink(target, link);
      } catch (err) {
        // Symlink failure is non-fatal (EEXIST on re-entry, EPERM on
        // read-only filesystem quirks). Hermes will fall back to
        // creating entries locally.
        process.stderr.write(
          `[hermes-home] symlink ${target} -> ${link} failed (non-fatal): ${
            (err as Error).message
          }\n`,
        );
      }
    }
  } else {
    // No real home yet — create the minimum skeleton Hermes expects.
    await mkdir(join(path, "logs"), { recursive: true });
  }

  // Telemetry paths live INSIDE the per-run HERMES_HOME (not symlinked
  // anywhere) so cleanup takes them with the rest of the dir. We pass
  // the absolute paths to the MCP server env, and execute.ts reads
  // them back before cleanup.
  const telemetry: McpTelemetryPaths = {
    auditLogPath: join(path, "mcp-tool-calls.ndjson"),
    livenessFilePath: join(path, "mcp-liveness.json"),
  };

  // Build per-run config.yaml. Start from whatever the real home had,
  // then inject our mcp_servers.paperclip block (with telemetry env).
  const realConfigPath = join(realHome, "config.yaml");
  let baseYaml = "";
  if (existsSync(realConfigPath)) {
    baseYaml = await readFile(realConfigPath, "utf-8");
  }
  const mergedYaml = mergeMcpServerIntoConfig(
    baseYaml,
    scope,
    opts.mcpCliPath,
    telemetry,
  );
  await writeFile(join(path, "config.yaml"), mergedYaml, { mode: 0o600 });

  return {
    path,
    auditLogPath: telemetry.auditLogPath!,
    livenessFilePath: telemetry.livenessFilePath!,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function sanitizeRunId(runId: string): string {
  // Allow alphanumerics, dash, underscore — keep the tmp dir name safe
  // against injection, path traversal, and odd filesystems.
  return runId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
}
