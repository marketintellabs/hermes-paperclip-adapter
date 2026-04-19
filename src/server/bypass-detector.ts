/**
 * Detect when the LLM bypassed the MCP tool surface and hit Paperclip
 * (or any HTTP endpoint) directly — e.g. by emitting `curl` commands
 * in its tool_use blocks or by shelling out via a Hermes shell tool.
 *
 * On v3+ templates this is explicitly forbidden in the prompt. When an
 * agent does it anyway, we want to:
 *
 *   1. Flag the run with `errorCode: "tool_bypass_attempt"` so
 *      CloudWatch / dashboards can count them and we can identify
 *      non-compliant agent configurations.
 *   2. Include the matched snippet in `errorMeta.patterns` so ops
 *      can tell *which* kind of bypass (raw curl, internal API host,
 *      wget, etc.) without re-reading the full transcript.
 *
 * The detector is purely advisory — it does NOT fail the run. An agent
 * that both used MCP tools AND ran a curl is still useful; we want the
 * observability without blocking legitimate (or semi-legitimate) work
 * on the first rollout. Follow-ups can flip this to a hard failure
 * once the signal is clean.
 *
 * We scan stdout (where Hermes echoes tool_use blocks) AND stderr
 * (where shell output leaks when a tool shells out). Both together
 * maximise the chance we see the curl.
 */

/**
 * Forbidden-pattern descriptor.
 *
 * Each entry has a human-readable name (what we surface to ops) and
 * a regex. We prefer regex over plain substring search because some
 * patterns (localhost, /api/) have false-positive neighbours we need
 * to exclude (e.g. "localhost" in a README snippet the LLM echoes).
 *
 * NOTE: keep this list short and high-precision. False positives here
 * mean a good agent gets tagged as a violator and someone wastes an
 * hour finding out the regex matched a doc comment in a toolchain log.
 */
export interface BypassPattern {
  name: string;
  regex: RegExp;
  /**
   * Human-readable explanation surfaced in errorMeta. Helps ops know
   * what the agent was trying to do without re-reading the transcript.
   */
  why: string;
}

/**
 * Default v3-template bypass patterns. Ordered by severity: the first
 * match wins the `primaryPattern` slot in the result, so put the most
 * damning (direct HTTP to Paperclip) first.
 */
export const DEFAULT_BYPASS_PATTERNS: BypassPattern[] = [
  {
    name: "paperclip_localhost",
    // matches http(s)://localhost:3100 or 127.0.0.1:3100 with a path
    regex: /https?:\/\/(?:localhost|127\.0\.0\.1|paperclip)(?::\d+)?\/api\//i,
    why: "Direct HTTP to Paperclip's internal host. MCP tools are the only supported path; talking to paperclip:3100 bypasses scope/audit.",
  },
  {
    name: "curl_paperclip",
    // matches `curl ... /issues/` or `curl ... /api/` on any host
    regex: /\bcurl\b[^\n]*\/(?:api\/|issues\/|companies\/|heartbeat-runs\/)/i,
    why: "curl invocation targeting a Paperclip API path. Use the corresponding MCP tool instead (get_issue, post_issue_comment, update_issue_status, etc.).",
  },
  {
    name: "wget_paperclip",
    regex: /\bwget\b[^\n]*\/(?:api\/|issues\/|companies\/)/i,
    why: "wget invocation targeting a Paperclip API path. Use the MCP tool.",
  },
  {
    name: "node_http_request",
    // naive but catches 99% of cases: require('http').request or
    // `new XMLHttpRequest` or `fetch("http…/api/issues…")`
    regex: /\bfetch\(\s*["'`]https?:\/\/[^"'`]*\/(?:api\/|issues\/)/i,
    why: "Programmatic fetch() to a Paperclip API path. Use the MCP tool.",
  },
];

/**
 * A single match within the scanned text.
 */
export interface BypassMatch {
  pattern: string;
  why: string;
  /** ~80-char snippet centered on the match, useful for ops triage. */
  snippet: string;
}

export interface BypassScanResult {
  /** True if any pattern matched in stdout or stderr. */
  flagged: boolean;
  /**
   * All matches, up to the cap below. We deduplicate by (pattern,
   * snippet) so a chatty agent that prints the same curl ten times
   * only shows up once.
   */
  matches: BypassMatch[];
  /**
   * The first pattern name we matched. Handy for routing (e.g. a
   * metric filter keyed on bypass_pattern).
   */
  primaryPattern: string | null;
}

const MAX_MATCHES = 10;
const SNIPPET_CONTEXT = 40;

/**
 * Scan stdout + stderr for any bypass pattern. Combines them into a
 * single haystack because a shell-out's curl typically echoes to stdout
 * (via the shell tool's capture) while its diagnostic output lands on
 * stderr — we want to catch either.
 */
export function scanForBypass(
  stdout: string,
  stderr: string,
  patterns: BypassPattern[] = DEFAULT_BYPASS_PATTERNS,
): BypassScanResult {
  const haystacks = [
    { source: "stdout", text: stdout || "" },
    { source: "stderr", text: stderr || "" },
  ];
  const matches: BypassMatch[] = [];
  // Dedup strategy:
  //   (a) identical matched substring across any haystack → one row
  //       (chatty agent printing the same curl 10× → counted once)
  //   (b) overlapping index range within a single haystack → one row
  //       (paperclip_localhost + curl_paperclip hitting the same
  //       `curl http://localhost:3100/api/...` → highest-severity wins)
  const seenExact = new Set<string>();
  const claimedRanges: Record<string, Array<[number, number]>> = {
    stdout: [],
    stderr: [],
  };
  let primary: string | null = null;

  const overlaps = (ranges: Array<[number, number]>, start: number, end: number) =>
    ranges.some(([a, b]) => start < b && end > a);

  for (const pattern of patterns) {
    for (const h of haystacks) {
      const re = new RegExp(
        pattern.regex.source,
        pattern.regex.flags.includes("g") ? pattern.regex.flags : pattern.regex.flags + "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(h.text)) !== null) {
        const matchStart = m.index;
        const matchEnd = m.index + m[0].length;
        const ranges = claimedRanges[h.source]!;

        // seenExact dedups identical substrings across patterns AND
        // haystacks. We add unconditionally — even if we skip the
        // match below for overlap, we still want the next identical
        // occurrence to be treated as a duplicate. Without that, an
        // agent that prints the same curl on three lines produces one
        // row from pattern A (line 1, overlap-drops pattern B) and
        // two more rows from pattern B (lines 2+3, no overlap).
        if (seenExact.has(m[0])) continue;
        seenExact.add(m[0]);

        if (overlaps(ranges, matchStart, matchEnd)) continue;
        ranges.push([matchStart, matchEnd]);

        const start = Math.max(0, matchStart - SNIPPET_CONTEXT);
        const end = Math.min(h.text.length, matchEnd + SNIPPET_CONTEXT);
        const snippet = h.text.slice(start, end).replace(/\s+/g, " ").trim();
        matches.push({ pattern: pattern.name, why: pattern.why, snippet });
        if (!primary) primary = pattern.name;
        if (matches.length >= MAX_MATCHES) {
          return { flagged: true, matches, primaryPattern: primary };
        }
      }
    }
  }

  return {
    flagged: matches.length > 0,
    matches,
    primaryPattern: primary,
  };
}
