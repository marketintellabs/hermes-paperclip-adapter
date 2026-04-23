# @marketintellabs/hermes-paperclip-adapter

> **Actively maintained by [MarketIntelLabs](https://marketintellabs.com).** This
> package is a [MarketIntelLabs](https://marketintellabs.com) fork of the
> upstream [`hermes-paperclip-adapter`](https://github.com/NousResearch/hermes-paperclip-adapter)
> by [Nous Research](https://nousresearch.com), published to npm as
> [`@marketintellabs/hermes-paperclip-adapter`](https://www.npmjs.com/package/@marketintellabs/hermes-paperclip-adapter).
>
> All production deploys at MarketIntelLabs consume this fork. Upstream credit
> for the core adapter design goes to Nous Research; all fork-specific
> behaviours (listed under [MIL-specific features](#mil-specific-features)
> below) are maintained here. See [`UPSTREAM.md`](./UPSTREAM.md) for the fork
> point, divergence list, and sync policy.

A [Paperclip](https://paperclip.ing) adapter that lets you run [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a managed employee in a Paperclip company.

Hermes Agent is a full-featured AI agent by [Nous Research](https://nousresearch.com) with 30+ native tools, persistent memory, session persistence, 80+ skills, MCP support, and multi-provider model access.

## Currently in flight (0.8.x)

The active workstream in this fork is **hardening the MCP tool plane**
shipped in 0.7.0. Hermes agents at MarketIntelLabs used to drive
Paperclip by executing `curl` commands the prompt template spelled out
for them — reliable-ish for reads, error-prone for writes, impossible to
scope, and impossible to audit. 0.7.0 moved all Paperclip interactions
onto a structured stdio MCP server (`paperclip-mcp`). 0.8.x closes the
observability, trust, and reliability gaps that surfaced once real
agents were running on v3:

**0.8.0-mil.0 (April 2026) — hardening:**

- **`update_issue_status` MCP tool** with scope enforcement — the LLM can
  transition an issue to `done`/`blocked`/`cancelled` through a
  structured call instead of a `RESULT:` marker, while the adapter
  still enforces `PAPERCLIP_ISSUE_ID` as the write boundary.
- **Per-call NDJSON audit log** written by the MCP server to
  `$HERMES_HOME/mcp-tool-calls.ndjson` (one `tool_call_start` /
  `tool_call_end` record per invocation), collected by `execute.ts` into
  `resultJson.toolCalls`, `toolCallCount`, `toolErrorCount`. First
  trustworthy record of what the LLM *actually* invoked (separate from
  whatever prose it wrote in its final response).
- **Curl-bypass detector** — post-run scan of stdout/stderr for
  `curl ... localhost:3100` and `/api/issues/...` shell invocations;
  flags the run with `errorCode: tool_bypass_attempt` so LLMs that
  ignore the "use tools, not curl" rule can't slip by unnoticed.
- **MCP subprocess liveness file + death detection** — the server
  writes its PID at startup and removes it on clean exit; the adapter
  detects stale PIDs post-run and flips `errorCode: tool_server_died`
  with the last-known call count. No more silent tool-plane failures.
- **`builtin:mil-heartbeat-v3` prompt update** — prefers the new
  `update_issue_status` tool over the `RESULT:` marker (marker retained
  as a structured fallback).

**0.8.1-mil.0 — env propagation fix (superseded by 0.8.3 note below):**
first attempt at restoring tool-call telemetry by setting
`PAPERCLIP_MCP_AUDIT_LOG` and `PAPERCLIP_MCP_LIVENESS_FILE` on the
adapter's own `env` block. That doesn't actually reach the MCP
subprocess — Hermes' `_build_safe_env` strips parent env down to a
small allowlist (`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`,
`SHELL`, `TMPDIR`, `XDG_*`) before merging `mcp_servers.<name>.env`.
The write is a no-op; 0.8.3 removes it and leans solely on the
config.yaml path (which `hermes-home.ts` has always populated).

**0.8.2-mil.0 — session-id poisoning fix:** when Hermes crashes because
`--resume <id>` names an unknown session it prints
`"Use a session ID from a previous CLI run"`. The legacy non-quiet
session-id regex matched the phrase `"session ID from"` and captured
the literal word `"from"` as a session id; Paperclip persisted it as
`session_id_after` and the next heartbeat re-ran `--resume from`,
crashing in exactly the same way. Fix is three layers of defense:
anchor the legacy regex to `session_id:` / `session saved:` with a
mandatory colon, reject captured tokens that don't look like real
session ids (`isPlausibleSessionId` — min length, must contain a
digit/hyphen/underscore), and skip session-id extraction entirely when
`"Session not found"` appears in the output. Regression pinned by nine
new tests in `parse-hermes-output.test.ts`.

**0.8.3-mil.0 — resume guard + config diagnostic:** two small defenses
on top of 0.8.2. (1) Before passing `--resume <id>` to `hermes chat`
we now re-run `isPlausibleSessionId` on the stored `sessionParams.sessionId`
via a new `resolveResumeSessionId` helper. If some other store (a
Hermes SQLite state file, a paperclip cache missed during cleanup)
still holds a poisoned value, we log the rejection and
let the run create a fresh session instead of inheriting a crash loop.
(2) After writing the per-run `config.yaml`, the adapter reads it
back and logs `audit=<bool> liveness=<bool>` so a single line of
`stdout_excerpt` now tells you whether the telemetry env block made
it into the file on disk — the only way we have to tell config.yaml
issues from Hermes-side env filtering issues without ECS Exec. The
belt-and-suspenders process-env write from 0.8.1 is removed (it never
worked — see the 0.8.1 note above).

**0.8.4-mil.0 — adapter version in resultJson:** every run now records
`resultJson.adapterVersion` (pulled from the new canonical
`src/shared/version.ts`) so dashboards, the runbook, and incident
forensics can tell at a glance which adapter produced a given run.
Critical during rollouts and hot-patches where the deployed adapter
version is the first thing you need to know and `stderr_excerpt` is
often truncated past the startup banner. The MCP server banner
(`[paperclip-mcp] server paperclip@<version> connected …`) now reads
from the same source.

**0.8.5-mil.0 — pre-spawn session existence probe:** closes the
A.1 gap in the 0.8.3 resume guard. 0.8.3 rejected session ids whose
*shape* was wrong (`"from"`, `"run"`, short English words); 0.8.5
rejects session ids whose shape looks right but that don't actually
exist in Hermes' SQLite session store. These appeared when
Paperclip's `agent_task_sessions.session_params_json.sessionId` kept
a reference to a session that was later wiped from disk (container
restart, state.db reset, ops prune). The next heartbeat would replay
`--resume <id>`, Hermes would exit with `Session not found: <id>`,
and the run would fail — forever, because the parser correctly
refuses to poison `session_id_after` from that error prose but the
*pre-existing* id keeps driving `--resume`.

The new `sessionExistsInHermesDb` probe (see
`src/server/session-probe.ts`) opens `$HERMES_HOME/state.db`
read-only via Node 24's stable `node:sqlite`, looks up the id in
`sessions`, and returns `{ exists: true|false|null }`. A definitive
`false` rejects the resume with a new
`reason: "rejected_not_in_state_db"` code; a `null` (no db, schema
drift, IO error) fails OPEN so a broken probe can never block all
resumes — Hermes' own lookup remains the source of truth. Log lines
are `[hermes] rejecting prevSessionId=... (not found in state.db)` and
`[hermes] session-probe unavailable (...) — resuming on shape-only
trust` respectively. Fifteen new tests in
`parse-hermes-output.test.ts` + `session-probe.test.ts` cover the
probe's fail-open/closed/unavailable paths and the guard's three-level
decision tree.

**0.8.6-mil.0 — fail-closed on missing state.db:** production
verification of 0.8.5 surfaced one remaining gap. 0.8.5 treated a
missing `state.db` as an *inconclusive* probe result (fail-open),
but Hermes creates `state.db` lazily on its first write — so the
file literally not existing means no sessions have ever been
persisted on this host and the id CANNOT be present. The 0.8.5
rollout itself hit this: the container restart wiped
`~/.hermes/state.db`, the probe said "state.db missing" and fell
open, `--resume` fired, and `Session not found: <id>` took down
the first heartbeat on 0.8.5. 0.8.6 inverts the decision: missing
state.db is a definitive "no" (`source: "no-state-db"`), and only
probe errors that leave state.db readable-but-inconclusive (corrupt
bytes, schema drift, permission denied) remain fail-open.

**0.8.7-mil.0 — adapter pre-flight skip for no-work wakes:** first
half of a two-part fix for an autonomous-work-loop failure mode
where idle agents on heartbeat schedules kept driving LLM calls
with no assigned work. Before invoking Hermes, the adapter now
queries
`GET /companies/:id/issues?assigneeAgentId=:agent` and, if zero
open issues are assigned, returns early with
`resultJson.preflight: "skipped"` and a `summary` noting no LLM
call was made. Explicit task/comment runs bypass the check
(heartbeat-driven work always proceeds). Any ambiguity — missing
credentials, network error, HTTP 5xx, malformed response — is
fail-open: the pre-flight is a cost optimization, never a
correctness barrier. The root cause it addresses: idle agents on
periodic heartbeat schedules were each burning a full LLM call per
wake just to discover there was nothing to do, multiplied across
the agent roster. Opt-out is `adapterConfig.preflightSkip: false`
per-agent. Eight new tests in `preflight.test.ts` cover the
explicit-bypass, fail-open, and skip-on-empty paths.

**0.8.8-mil.0 — per-agent MCP tool allowlist + `create_sub_issue`
requires `parentIssueId`:** companion to 0.8.7. 0.8.7 stops the LLM
call on no-work wakes; 0.8.8 stops fabrication of new top-level
issues even when an agent legitimately runs.

Two structural changes: (1) `create_sub_issue` now rejects missing
or blank `parentIssueId` with `retryPolicy: fix-args`. Combined
with the existing `assertWriteScope` (which already required
parent == current issue when a parent was set), agents can only
create sub-tasks nested under the issue they're actively working
on. Previously the schema allowed `parentIssueId: undefined`, the
LLM obliged when told to "break work down into sub-issues", and the
resulting sub-issue became a top-level issue with no parent — the
mechanism behind top-level-issue fabrication bursts seen in the
wild. (2) `buildServer({ allowedTools })` now accepts a per-agent
list of tool names and filters `ALL_TOOLS` to only those —
propagated to the MCP subprocess via a comma-separated
`PAPERCLIP_MCP_TOOLS` env var on the per-run `config.yaml`.
Unknown names log + skip (typo-tolerant). Three env states are
distinguished: unset → register all (backwards compat), `""`
(explicit empty) → deny-all, `"a,b,c"` → allowlist. The empty
string deny-all is important for the round-trip: an operator who
writes `paperclipMcpTools: []` in the agent config must see an
MCP server that registers nothing, not one that falls back to
register-everything.

Recommended consumer-side policy: delegator agents (those that are
expected to break work down) get the 4-tool base set
(`list_my_issues`, `get_issue`, `post_issue_comment`,
`update_issue_status`) plus `create_sub_issue`; worker agents get
only the base set. Workers can read their queue, read an issue,
comment, and close — but the `create_sub_issue` tool is not even
registered in their MCP subprocess, so the LLM cannot attempt the
call. Eleven new tests in `server.test.ts` + `hermes-home.test.ts`
+ `tools.test.ts` cover allowlist filtering, env round-trip, and
the new `parentIssueId` required/blank rejection paths.

Rollout is gated per-agent by `adapterConfig.promptTemplate`: flip one
agent to `builtin:mil-heartbeat-v3` at a time, flip back to v2 to roll
back. The 0.8.x hardening only kicks in on v3 runs. See the
[fork divergence list](./UPSTREAM.md#divergence-from-upstream)
(items 8–15) for the implementation sketch.

## MIL-specific features

Features you get in this fork that upstream doesn't ship:

- **Adapter-owned status transitions** (`builtin:mil-heartbeat-v2+`) —
  the adapter PATCHes the issue to `in_progress` before spawning Hermes
  and transitions it to the terminal status the LLM signalled via a
  `RESULT:` marker, instead of trusting the LLM to run the status
  `PATCH` itself. See [`src/server/result-marker.ts`](./src/server/result-marker.ts).
- **MCP tool server** (`builtin:mil-heartbeat-v3`, 0.7.0+) — see
  [Currently in flight](#currently-in-flight-08x) above.
- **Per-run `HERMES_HOME`** (0.7.0+) — race-free per-run configuration
  for the MCP server. See [`src/server/hermes-home.ts`](./src/server/hermes-home.ts).
- **MCP tool audit + bypass + death detection** (0.8.0+) — every run
  that used the MCP tool plane gets a trustworthy record of which
  tools were invoked (`resultJson.toolCalls`), a flag when the LLM
  tried to bypass it with `curl` (`errorCode: tool_bypass_attempt`),
  and a flag when the stdio subprocess died mid-run
  (`errorCode: tool_server_died`). See `src/server/mcp-telemetry.ts`,
  `src/server/bypass-detector.ts`.
- **`update_issue_status` MCP tool** (0.8.0+) — structured status
  transitions enforced by `PAPERCLIP_ISSUE_ID` scope. Replaces the
  `RESULT:` marker as the preferred signal; marker stays as a
  fallback.
- **Session-id poisoning guard** (0.8.2+) — the legacy session-id
  regex is anchored and validated so Hermes' own error prose can't be
  mis-captured as a session id.
- **OpenRouter model-prefix hints** — `anthropic/`, `openai/`, `x-ai/`,
  `zai-org/` model IDs route to `provider: openrouter` automatically.
- **Two MIL heartbeat prompt templates** shipped in the package
  (`templates/mil-heartbeat{,-v2,-v3}.md`) selectable via
  `promptTemplate: "builtin:<name>"`.
- **Benign-stderr classifier** (0.4.1+) — stderr only flips
  `errorMessage` on strong failure signatures, not substring matches.
- **Run-context resolution** (0.4.2+) — per-run fields resolved from
  `ctx.context` (the modern Paperclip shape) with `ctx.config` fallback.
- **Runtime hot-patch deploy path** — MarketIntelLabs' infra ships a
  `scripts/upgrade-adapter.sh` that overlays a new adapter tarball onto
  running ECS tasks without a Docker rebuild, cutting deploy time from
  20-40 min to ~3 min. Requires the companion `ops-entrypoint.sh` hook
  shipped in the [`marketintellabs`](https://github.com/marketintellabs/marketintellabs) infra repo.
- **Release workflow** — `.github/workflows/release.yml` publishes to
  npm on every `v*` tag push.

## Key upstream features (unchanged)

- **8 inference providers** — Anthropic, OpenRouter, OpenAI, Nous, OpenAI Codex, ZAI, Kimi Coding, MiniMax
- **Skills integration** — Scans both Paperclip-managed and Hermes-native skills (`~/.hermes/skills/`), with sync/list/resolve APIs
- **Structured transcript parsing** — Raw Hermes stdout is parsed into typed `TranscriptEntry` objects so Paperclip renders proper tool cards with status icons and expand/collapse
- **Rich post-processing** — Converts Hermes ASCII banners, setext headings, and `+--+` table borders into clean GFM markdown
- **Comment-driven wakes** — Agents wake to respond to issue comments, not just task assignments
- **Auto model detection** — Reads `~/.hermes/config.yaml` to pre-populate the UI with the user's configured model
- **Session codec** — Structured validation and migration of session state across heartbeats
- **Session source tagging** — Sessions are tagged as `tool` source so they don't clutter the user's interactive history
- **Filesystem checkpoints** — Optional `--checkpoints` for rollback safety
- **Thinking effort control** — Passes `--reasoning-effort` for thinking/reasoning models

### Hermes Agent Capabilities

| Feature | Claude Code | Codex | Hermes Agent |
|---------|------------|-------|-------------|
| Persistent memory | ❌ | ❌ | ✅ Remembers across sessions |
| Native tools | ~5 | ~5 | 30+ (terminal, file, web, browser, vision, git, etc.) |
| Skills system | ❌ | ❌ | ✅ 80+ loadable skills |
| Session search | ❌ | ❌ | ✅ FTS5 search over past conversations |
| Sub-agent delegation | ❌ | ❌ | ✅ Parallel sub-tasks |
| Context compression | ❌ | ❌ | ✅ Auto-compresses long conversations |
| MCP client | ❌ | ❌ | ✅ Connect to any MCP server |
| Multi-provider | Anthropic only | OpenAI only | ✅ 8 providers out of the box |

## Installation

```bash
npm install @marketintellabs/hermes-paperclip-adapter
```

The package also ships a `paperclip-mcp` bin for the MCP tool server,
which the adapter launches automatically when a run resolves to
`builtin:mil-heartbeat-v3`. You shouldn't need to invoke it directly.

### Prerequisites

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed (`pip install hermes-agent`)
- Python 3.10+
- **Node 24+** (the MCP tool server uses Node 24-compatible APIs; see `engines` in `package.json`)
- At least one LLM API key (Anthropic, OpenRouter, or OpenAI)

## Quick Start

### 1. Register the adapter in your Paperclip server

Add to your Paperclip server's adapter registry (`server/src/adapters/registry.ts`):

```typescript
import * as hermesLocal from "@marketintellabs/hermes-paperclip-adapter";
import {
  execute,
  testEnvironment,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
} from "@marketintellabs/hermes-paperclip-adapter/server";

registry.set("hermes_local", {
  ...hermesLocal,
  execute,
  testEnvironment,
  detectModel,
  listSkills,
  syncSkills,
  sessionCodec,
});
```

### 2. Create a Hermes agent in Paperclip

In the Paperclip UI or via API, create an agent with adapter type `hermes_local`:

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4.5",
    "promptTemplate": "builtin:mil-heartbeat-v3",
    "timeoutSec": 300,
    "persistSession": true,
    "enabledToolsets": ["terminal", "file", "web"]
  }
}
```

The `promptTemplate` values you can pick from:

| Value | Behaviour |
|-------|-----------|
| `builtin:mil-heartbeat` | Legacy. LLM drives status transitions via curl. Kept for back-compat. |
| `builtin:mil-heartbeat-v2` | Adapter-owned status. LLM signals outcome via a `RESULT:` marker; adapter PATCHes status. Still uses curl for Paperclip reads/writes. |
| `builtin:mil-heartbeat-v3` | MCP tool server. All Paperclip interactions go through structured tools; curl-in-prompt removed. Adapter-owned status inherited from v2. |
| `(omitted)` | Upstream default template. |
| `<any other string>` | Treated as a literal template with `{{var}}` substitution. |

### 3. Assign work

Create issues in Paperclip and assign them to your Hermes agent. On each heartbeat, Hermes will:

1. Receive the task instructions
2. Use its full tool suite to complete the work
3. Report results back to Paperclip
4. Persist session state for continuity

## Configuration Reference

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `anthropic/claude-sonnet-4.5` | Model in `provider/model` format |
| `provider` | string | *(auto-detected)* | API provider: `auto`, `openrouter`, `nous`, `openai-codex`, `zai`, `kimi-coding`, `minimax`, `minimax-cn` |
| `timeoutSec` | number | `300` | Execution timeout in seconds |
| `graceSec` | number | `10` | Grace period before SIGKILL |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | *(all)* | Comma-separated toolsets to enable (e.g. `"terminal,file,web"`) |

Available toolsets: `terminal`, `file`, `web`, `browser`, `code_execution`, `vision`, `mcp`, `creative`, `productivity`

### Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistSession` | boolean | `true` | Resume sessions across heartbeats |
| `worktreeMode` | boolean | `false` | Git worktree isolation |
| `checkpoints` | boolean | `false` | Enable filesystem checkpoints for rollback |

### Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hermesCommand` | string | `hermes` | Custom CLI binary path |
| `verbose` | boolean | `false` | Enable verbose output |
| `quiet` | boolean | `true` | Quiet mode (clean output, no banner/spinner) |
| `extraArgs` | string[] | `[]` | Additional CLI arguments |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | *(built-in)* | Custom prompt template or `builtin:<name>` (see above) |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100/api` | Paperclip API base URL |

### Prompt Template Variables

Use `{{variable}}` syntax in `promptTemplate`:

| Variable | Description |
|----------|-------------|
| `{{agentId}}` | Paperclip agent ID |
| `{{agentName}}` | Agent display name |
| `{{companyId}}` | Company ID |
| `{{companyName}}` | Company name |
| `{{runId}}` | Current heartbeat run ID |
| `{{taskId}}` | Assigned task/issue ID |
| `{{taskTitle}}` | Task title |
| `{{taskBody}}` | Task instructions |
| `{{projectName}}` | Project name |
| `{{paperclipApiUrl}}` | Paperclip API base URL |
| `{{commentId}}` | Comment ID (when woken by a comment) |
| `{{wakeReason}}` | Reason this run was triggered |

Conditional sections:

- `{{#taskId}}...{{/taskId}}` — included only when a task is assigned
- `{{#noTask}}...{{/noTask}}` — included only when no task (heartbeat check)
- `{{#commentId}}...{{/commentId}}` — included only when woken by a comment

## Architecture

```
Paperclip                          Hermes Agent
┌──────────────────┐               ┌──────────────────┐
│  Heartbeat       │               │                  │
│  Scheduler       │───execute()──▶│  hermes chat -q  │
│                  │               │                  │
│  Issue System    │               │  30+ Tools       │
│  Comment Wakes   │◀──results─────│  Memory System   │
│                  │               │  Session DB      │
│  Cost Tracking   │               │  Skills          │
│                  │               │  MCP Client      │──▶ paperclip-mcp
│  Skill Sync      │◀──snapshot────│  ~/.hermes/skills│    (v3 agents only,
│  Org Chart       │               │                  │     scope-bound per run)
└──────────────────┘               └──────────────────┘
```

The adapter spawns Hermes Agent's CLI in single-query mode (`-q`). Hermes
processes the task using its full tool suite, then exits. The adapter:

1. **Captures** stdout/stderr and parses token usage, session IDs, and cost
2. **Parses** raw output into structured `TranscriptEntry` objects (tool cards with status icons)
3. **Post-processes** Hermes ASCII formatting (banners, setext headings, table borders) into clean GFM markdown
4. **Reclassifies** benign stderr (MCP init, structured logs) so they don't show as errors
5. **Tags** sessions as `tool` source to keep them separate from interactive usage
6. **Reports** results back to Paperclip with cost, usage, and session state

Session persistence works via Hermes's `--resume` flag — each run picks
up where the last one left off, maintaining conversation context,
memories, and tool state across heartbeats. The `sessionCodec` validates
and migrates session state between runs.

### Skills Integration

The adapter scans two skill sources and merges them:

- **Paperclip-managed skills** — bundled with the adapter, togglable from the UI
- **Hermes-native skills** — from `~/.hermes/skills/`, read-only, always loaded

The `listSkills` / `syncSkills` APIs expose a unified snapshot so the
Paperclip UI can display both managed and native skills in one view.

### MCP Tool Server (v3 agents)

For agents on `builtin:mil-heartbeat-v3`, the adapter additionally:

1. Builds a per-run `HERMES_HOME` at `/tmp/paperclip-run-<runId>-XXXXXX/`.
2. Symlinks `sessions/`, `skills/`, `.env`, and other entries from the
   real `~/.hermes/` into it (so session resume + skills keep working).
3. Writes a fresh `config.yaml` into the per-run dir that contains the
   base config plus an `mcp_servers.paperclip` block whose `env` block
   carries *this run's* `PAPERCLIP_API_KEY` (JWT), `PAPERCLIP_AGENT_ID`,
   `PAPERCLIP_COMPANY_ID`, and — critically — `PAPERCLIP_ISSUE_ID`
   (the scope boundary for writes).
4. Spawns Hermes with `HERMES_HOME` pointing at the per-run dir.
5. Teardown (`rm -rf`) runs in `finally`, so the temp dir is cleaned up
   even on timeout or crash.

Hermes spawns the `paperclip-mcp` subprocess over stdio. All tool calls
go through that subprocess with a server-side `MAX_TOOL_CALLS=20` cap,
structured per-call logging (`[paperclip-mcp-log]`), and scope
enforcement. 0.8.0+ additionally writes two sidecar files inside the
per-run `HERMES_HOME`:

- `mcp-tool-calls.ndjson` — one `tool_call_start` / `tool_call_end`
  JSON record per invocation. `execute.ts` reads this after the run
  and fills `resultJson.toolCalls` / `toolCallCount` / `toolErrorCount`.
- `mcp-server.pid` — written at startup, removed on clean exit.
  `execute.ts` checks it post-run to detect a crashed tool plane
  (`errorCode: tool_server_died`).

Both files' paths are passed to the subprocess via
`PAPERCLIP_MCP_AUDIT_LOG` / `PAPERCLIP_MCP_LIVENESS_FILE` env vars set
directly on the Hermes process (Hermes does not forward the per-server
`env` block in `config.yaml` to stdio subprocesses — 0.8.1 fix).

## Development

```bash
git clone https://github.com/marketintellabs/hermes-paperclip-adapter
cd hermes-paperclip-adapter
npm install
npm run build
npm test       # 107 tests across 24 suites
```

See [`AGENTS.md`](./AGENTS.md) for the source tree layout and
[`UPSTREAM.md`](./UPSTREAM.md) for the fork's divergence from upstream +
sync policy.

## License

MIT — see [LICENSE](LICENSE). Inherited from upstream unchanged.

## Links

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the AI agent this adapter runs (upstream)
- [Paperclip](https://github.com/paperclipai/paperclip) — the orchestration platform
- [MarketIntelLabs](https://marketintellabs.com) — maintainer of this fork
- [Nous Research](https://nousresearch.com) — upstream adapter author
- [Paperclip Docs](https://paperclip.ing/docs) — Paperclip documentation
