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
}

export interface PerRunHermesHome {
  /** Absolute path to the temp dir that should be set as `HERMES_HOME`. */
  path: string;
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
 * Build the mcp_servers.paperclip block as a plain JS object. Split out
 * so tests can assert on it without file-system side effects.
 */
export function buildMcpServerSpec(
  scope: PaperclipMcpScope,
  mcpCliPath: string = resolveMcpCliPath(),
): Record<string, unknown> {
  const env: Record<string, string> = {
    PAPERCLIP_API_URL: scope.apiUrl,
    PAPERCLIP_API_KEY: scope.apiKey,
  };
  if (scope.agentId) env.PAPERCLIP_AGENT_ID = scope.agentId;
  if (scope.companyId) env.PAPERCLIP_COMPANY_ID = scope.companyId;
  if (scope.issueId) env.PAPERCLIP_ISSUE_ID = scope.issueId;
  if (scope.runId) env.PAPERCLIP_RUN_ID = scope.runId;

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
 * Merge a Paperclip MCP scope into a base Hermes config YAML string.
 * Preserves any other `mcp_servers.<name>` entries the operator has
 * added (gmail, github, etc.) and overwrites only the `paperclip` entry.
 *
 * Exported for unit testing — production callers use
 * {@link buildPerRunHermesHome} which reads/writes the file.
 */
export function mergeMcpServerIntoConfig(
  baseConfigYaml: string,
  scope: PaperclipMcpScope,
  mcpCliPath: string = resolveMcpCliPath(),
): string {
  const parsed = (baseConfigYaml.trim() ? parseYaml(baseConfigYaml) : {}) as
    | Record<string, unknown>
    | null;
  const base: Record<string, unknown> = parsed && typeof parsed === "object" ? parsed : {};

  const existing = (base.mcp_servers as Record<string, unknown> | undefined) ?? {};
  base.mcp_servers = {
    ...existing,
    paperclip: buildMcpServerSpec(scope, mcpCliPath),
  };

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

  // Build per-run config.yaml. Start from whatever the real home had,
  // then inject our mcp_servers.paperclip block.
  const realConfigPath = join(realHome, "config.yaml");
  let baseYaml = "";
  if (existsSync(realConfigPath)) {
    baseYaml = await readFile(realConfigPath, "utf-8");
  }
  const mergedYaml = mergeMcpServerIntoConfig(baseYaml, scope, opts.mcpCliPath);
  await writeFile(join(path, "config.yaml"), mergedYaml, { mode: 0o600 });

  return {
    path,
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
