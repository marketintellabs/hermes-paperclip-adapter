/**
 * Adapter health-check.
 *
 * Why this exists separately from `testEnvironment`
 * --------------------------------------------------
 * `testEnvironment` is the Paperclip UI's "Test Environment" button —
 * it's invoked once at agent-config time, runs synchronously inside
 * the Paperclip server process, and answers a configuration question:
 * "is this agent likely to work?"
 *
 * What ops actually need is a different question, asked at a
 * different time, by a different caller. When the Staff Engineer
 * agent (or a human triaging an alert) is debugging a stuck or
 * failed agent, they want a *runtime* readiness probe that confirms
 * the surroundings the spawned `hermes chat` process is going to see
 * — Hermes binary in PATH, EFS / `$HERMES_HOME` mounted and writable,
 * `state.db` accessible, the upstream LLM endpoint reachable. That
 * answers "is the agent's container healthy *right now*?"
 *
 * Design points
 * -------------
 * - Pure structured output (`HealthCheckResult`). No console writes
 *   here — that's the CLI wrapper's job.
 * - Each probe is independently catch-all. One failed check NEVER
 *   prevents subsequent checks from running. This is the opposite
 *   of `testEnvironment`'s short-circuit on the CLI-not-found error
 *   — for ops we want every signal we can collect.
 * - Network ping is bounded by an explicit AbortSignal.timeout, so
 *   a hung DNS / TCP path can't wedge the whole probe.
 * - Fail-open semantics on advisory checks (e.g. Anthropic models'
 *   reachability) — they degrade `status` to "warn", not "fail".
 *   Fail-closed only on the foundational checks (binary missing,
 *   $HERMES_HOME unwritable).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants as fsConstants, mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DatabaseSync } from "node:sqlite";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveRealHermesHome } from "./session-probe.js";

const execFileAsync = promisify(execFile);

export type CheckLevel = "info" | "warn" | "error";

export interface CheckResult {
  /** Stable identifier — safe to switch on in dashboards / alerts. */
  code: string;
  level: CheckLevel;
  message: string;
  /** Optional remediation hint shown to a human operator. */
  hint?: string;
  /** Optional structured detail for machine consumers. */
  detail?: Record<string, unknown>;
}

export interface HealthCheckResult {
  status: "pass" | "warn" | "fail";
  checks: CheckResult[];
  /** ISO-8601 timestamp of when the probe finished. */
  testedAt: string;
  /** Adapter version baked into the build. */
  adapterVersion: string;
  /** Resolved $HERMES_HOME at probe time. */
  hermesHome: string;
}

export interface HealthCheckOptions {
  /** Override the hermes binary to invoke. Defaults to constants.HERMES_CLI. */
  hermesCommand?: string;
  /** Override $HERMES_HOME. Defaults to env-resolved real home. */
  hermesHome?: string;
  /** OpenRouter base URL. Defaults to https://openrouter.ai. */
  openRouterUrl?: string;
  /** Skip the OpenRouter reachability probe (offline test). */
  skipNetwork?: boolean;
  /** Network probe timeout in ms (default 5000). */
  networkTimeoutMs?: number;
  /** Override `fetch` — used in tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai";
const DEFAULT_NETWORK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Individual probes
// ---------------------------------------------------------------------------

async function probeHermesBinary(command: string): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: 10_000,
    });
    const version = stdout.trim();
    return {
      code: "hermes_binary",
      level: "info",
      message: version
        ? `Hermes Agent binary OK (${version})`
        : "Hermes Agent binary OK (version: unknown)",
      detail: { command, version },
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        code: "hermes_binary",
        level: "error",
        message: `Hermes binary "${command}" not found in PATH`,
        hint: "Ensure the container image installs hermes-agent and the CLI is on PATH",
        detail: { command },
      };
    }
    return {
      code: "hermes_binary",
      level: "error",
      message: `Hermes binary "${command}" failed: ${e.message ?? String(err)}`,
      hint: "Run `hermes --version` manually to surface the underlying error",
      detail: { command, error: e.message },
    };
  }
}

/**
 * Confirm $HERMES_HOME exists, is a directory, and is writable.
 * Performs the writability test by creating + deleting a temp file
 * inside the dir — `access(W_OK)` lies on some EFS configurations.
 */
async function probeHermesHome(hermesHome: string): Promise<CheckResult> {
  let s;
  try {
    s = await stat(hermesHome);
  } catch (err) {
    return {
      code: "hermes_home_missing",
      level: "error",
      message: `$HERMES_HOME does not exist: ${hermesHome}`,
      hint:
        "Verify EFS / volume mount in the task definition, or unset HERMES_HOME " +
        "to fall back to ~/.hermes",
      detail: { path: hermesHome, error: (err as Error).message },
    };
  }
  if (!s.isDirectory()) {
    return {
      code: "hermes_home_not_dir",
      level: "error",
      message: `$HERMES_HOME exists but is not a directory: ${hermesHome}`,
      detail: { path: hermesHome },
    };
  }

  // Real writability test (mkdtemp), since `access(W_OK)` returns
  // success on read-only EFS mounts under some configurations.
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(join(hermesHome, ".health-check-"));
  } catch (err) {
    return {
      code: "hermes_home_unwritable",
      level: "error",
      message: `$HERMES_HOME is not writable: ${hermesHome}`,
      hint: "Check filesystem permissions and EFS access-point configuration",
      detail: { path: hermesHome, error: (err as Error).message },
    };
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    code: "hermes_home_ok",
    level: "info",
    message: `$HERMES_HOME OK (${hermesHome})`,
    detail: { path: hermesHome },
  };
}

/**
 * Confirm `$HERMES_HOME/state.db` is readable. Missing is OK — Hermes
 * creates it on first use; we only flag if the file exists but can't
 * be opened (corruption, schema mismatch, permission).
 */
async function probeStateDb(hermesHome: string): Promise<CheckResult> {
  const path = join(hermesHome, "state.db");
  if (!existsSync(path)) {
    return {
      code: "state_db_absent",
      level: "info",
      message: "state.db not present yet (will be created on first run)",
      detail: { path },
    };
  }
  try {
    await access(path, fsConstants.R_OK);
  } catch (err) {
    return {
      code: "state_db_unreadable",
      level: "error",
      message: `state.db exists but is not readable: ${path}`,
      hint: "Check file permissions; consider re-creating the volume",
      detail: { path, error: (err as Error).message },
    };
  }
  // Try to actually open + query the sessions table. Fail-soft on
  // any sqlite-side surprise.
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const stmt = db.prepare("SELECT COUNT(*) AS n FROM sessions");
      const row = stmt.get() as { n: number } | undefined;
      const sessionCount = row?.n ?? 0;
      return {
        code: "state_db_ok",
        level: "info",
        message: `state.db OK (${sessionCount} session(s))`,
        detail: { path, sessionCount },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      code: "state_db_open_failed",
      level: "warn",
      message: `state.db open/query failed: ${(err as Error).message}`,
      hint:
        "Hermes can recover by recreating the table, but persisted sessions may be lost",
      detail: { path, error: (err as Error).message },
    };
  }
}

/**
 * Reachability probe for the upstream LLM endpoint. Default target is
 * OpenRouter's public `/api/v1/models` listing — unauthenticated, so a
 * non-2xx is a real signal (DNS, TCP, TLS, edge outage), not an auth
 * problem. Operators can point this at any endpoint via opts.
 */
async function probeOpenRouter(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<CheckResult> {
  const target = `${url.replace(/\/$/, "")}/api/v1/models`;
  const t0 = Date.now();
  try {
    const res = await fetchImpl(target, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      return {
        code: "openrouter_unhealthy",
        level: "warn",
        message: `OpenRouter probe returned HTTP ${res.status} in ${elapsedMs}ms`,
        hint:
          "Could be a transient edge issue. Check https://status.openrouter.ai before paging",
        detail: { url: target, status: res.status, elapsedMs },
      };
    }
    return {
      code: "openrouter_ok",
      level: "info",
      message: `OpenRouter reachable (${elapsedMs}ms)`,
      detail: { url: target, status: res.status, elapsedMs },
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return {
      code: "openrouter_unreachable",
      level: "warn",
      message: `OpenRouter unreachable: ${(err as Error).message} (after ${elapsedMs}ms)`,
      hint: "DNS/TCP/TLS issue; verify VPC egress and DNS resolution from the container",
      detail: { url: target, elapsedMs, error: (err as Error).message },
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

import { ADAPTER_VERSION } from "../shared/version.js";

export async function runHealthCheck(
  opts: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const hermesCommand = opts.hermesCommand ?? HERMES_CLI;
  const hermesHome = opts.hermesHome ?? resolveRealHermesHome();
  const openRouterUrl = opts.openRouterUrl ?? DEFAULT_OPENROUTER_URL;
  const networkTimeoutMs = opts.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const checks: CheckResult[] = [];

  checks.push(await probeHermesBinary(hermesCommand));
  checks.push(await probeHermesHome(hermesHome));
  checks.push(await probeStateDb(hermesHome));

  if (!opts.skipNetwork) {
    checks.push(await probeOpenRouter(openRouterUrl, networkTimeoutMs, fetchImpl));
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");
  const status: HealthCheckResult["status"] = hasError ? "fail" : hasWarn ? "warn" : "pass";

  return {
    status,
    checks,
    testedAt: new Date().toISOString(),
    adapterVersion: ADAPTER_VERSION,
    hermesHome,
  };
}
