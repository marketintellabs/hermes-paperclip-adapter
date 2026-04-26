/**
 * Auto-repair detector — surfaces Hermes' silent fuzzy tool-name rewrites.
 *
 * Background
 * ──────────
 * Hermes Agent's Python tool-call parser (`/opt/hermes-agent/run_agent.py`)
 * runs a fuzzy match on every emitted `<TOOLCALL>{...}</TOOLCALL>` block.
 * If the LLM hallucinates a tool name that doesn't exist exactly in the
 * agent's tool registry — either a typo, a stale name from a recently
 * renamed tool, or a *brand-new* tool the worker isn't authorised for —
 * Hermes silently rewrites the call to the closest-matching tool that IS
 * registered, prints a single `🔧 Auto-repaired tool name: 'X' -> 'Y'`
 * line to stdout, and dispatches the rewritten call.
 *
 * The original Hermes log line is technically present in the run
 * transcript, but in practice it's buried inside hundreds of other
 * stdout lines and almost never read. We've observed cases like a
 * non-delegator worker asking for `mcp_paperclip_create_sub_issues`
 * (a tool only delegators have access to) getting silently mapped to
 * `mcp_paperclip_get_issue` — the call "succeeds", returns garbage from
 * the worker's POV, and the actual decomposition the LLM intended never
 * happens. No alarm, no failed run, no telemetry — pure silent breakage.
 *
 * What this module does
 * ─────────────────────
 * Watches the Hermes stdout/stderr stream for the auto-repair signature
 * line, extracts the original→repaired tool names, and:
 *
 *   1. Always emits an `[hermes] ERROR: auto-repair …` line on stderr
 *      so Paperclip's UI renders it in the red error track instead of
 *      blending into stdout. (We don't suppress the original Hermes
 *      line — operators can correlate timestamps if they want context.)
 *   2. When the agent has a `paperclipMcpTools` allowlist, classifies
 *      whether the *original* (pre-repair) tool name was authorised
 *      for this agent. If not, the alert message says so explicitly:
 *      "ORIGINAL tool was NOT in the per-agent allowlist".
 *   3. Tracks every detection in a small array so `execute.ts` can
 *      embed it in `result_json.autoRepairs` for post-hoc analysis.
 *
 * What this module does NOT do
 * ────────────────────────────
 * It does NOT abort the run. Hermes' auto-repair sometimes saves a
 * benign typo (e.g. `list_my_issue` → `list_my_issues`) and we don't
 * want to nuke working agents. Killing the process is reserved for the
 * hard timeout. Loud + observable is the contract; the operator decides
 * policy from there.
 *
 * Disable via `adapterConfig.autoRepairAlerts = false`.
 */

const AUTO_REPAIR_PATTERN =
  /🔧\s*Auto-repaired tool name:\s*'([^']+)'\s*->\s*'([^']+)'/;

/** A single observed auto-repair event. */
export interface AutoRepairDetection {
  /** Tool name the LLM asked for (pre-repair). */
  original: string;
  /** Tool name Hermes rewrote it to (post-repair). */
  repaired: string;
  /**
   * If a per-agent `paperclipMcpTools` allowlist was supplied, whether
   * the ORIGINAL tool name (with the `mcp_paperclip_` prefix stripped)
   * was in it. `null` when no allowlist was supplied.
   */
  unauthorized: boolean | null;
  /** ISO timestamp the line was observed. */
  ts: string;
}

export interface AutoRepairDetectorOptions {
  /**
   * Per-agent MCP tool allowlist (already-resolved string array). When
   * provided, the detector classifies each detection's `unauthorized`
   * field. When omitted/null, `unauthorized` is always `null`.
   */
  allowedTools?: readonly string[] | null;
  /** Operator opt-out (default: enabled). */
  enabled?: boolean;
}

export interface AutoRepairDetector {
  /**
   * Feed a chunk (one or more `\n`-separated lines) from Hermes stdout
   * or stderr. Returns the alert lines that should be emitted as stderr
   * to surface the detections — empty array when the chunk had no
   * auto-repair signature (the steady state).
   */
  observe(chunk: string, ts?: string): string[];
  /** All detections observed so far. */
  detections(): readonly AutoRepairDetection[];
}

/**
 * Strip the conventional `mcp_<server>_` prefix Hermes adds when it
 * advertises an MCP tool to the model. We allowlist the bare tool name
 * (`get_issue`), not the namespaced form (`mcp_paperclip_get_issue`),
 * so the membership check has to compare on the bare form.
 */
function stripMcpPrefix(name: string): string {
  // Matches `mcp_<server>_<rest>` where `<server>` is one or more
  // `[a-zA-Z0-9-]` chars. Anchored so we only strip the leading prefix.
  const m = name.match(/^mcp_[A-Za-z0-9-]+_(.+)$/);
  return m ? m[1] : name;
}

function classifyUnauthorized(
  original: string,
  allowedTools: readonly string[] | null | undefined,
): boolean | null {
  if (!allowedTools || allowedTools.length === 0) return null;
  const bare = stripMcpPrefix(original);
  // Compare against both the bare and namespaced forms so this works
  // whether the operator stored allowlist entries with or without the
  // mcp_paperclip_ prefix (configure-agents.mjs uses bare names but
  // we don't want to silently miss namespaced entries either).
  return !(allowedTools.includes(bare) || allowedTools.includes(original));
}

/**
 * Format the loud alert line. The `[hermes] ERROR:` prefix matches the
 * convention `wrappedOnLog` already uses for things that should land
 * in Paperclip's red error track.
 */
export function formatAutoRepairAlert(d: AutoRepairDetection): string {
  const tag =
    d.unauthorized === true
      ? "ORIGINAL tool was NOT in the per-agent allowlist"
      : d.unauthorized === false
        ? "original tool IS in the per-agent allowlist (likely typo or near-miss)"
        : "no per-agent allowlist configured";
  return (
    `[hermes] ERROR: auto-repair: Hermes silently rewrote ` +
    `'${d.original}' → '${d.repaired}'; ${tag}. ` +
    `The LLM's original intent was lost — investigate before trusting ` +
    `this run's output.\n`
  );
}

export function createAutoRepairDetector(
  opts: AutoRepairDetectorOptions = {},
): AutoRepairDetector {
  const enabled = opts.enabled !== false;
  const allowed = opts.allowedTools ?? null;
  const observed: AutoRepairDetection[] = [];

  return {
    observe(chunk, ts) {
      if (!enabled || !chunk) return [];
      // Hermes flushes one logical line at a time but pipes can deliver
      // multi-line chunks; split defensively. We don't assume `\n` —
      // CRLF is uncommon but cheap to handle.
      const lines = chunk.split(/\r?\n/);
      const alerts: string[] = [];
      for (const raw of lines) {
        const m = raw.match(AUTO_REPAIR_PATTERN);
        if (!m) continue;
        const detection: AutoRepairDetection = {
          original: m[1],
          repaired: m[2],
          unauthorized: classifyUnauthorized(m[1], allowed),
          ts: ts ?? new Date().toISOString(),
        };
        observed.push(detection);
        alerts.push(formatAutoRepairAlert(detection));
      }
      return alerts;
    },
    detections() {
      return observed;
    },
  };
}
