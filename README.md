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

## Currently in flight (0.7.x)

The active workstream in this fork is **replacing curl-in-prompt with a
structured MCP tool server**. Hermes agents at MarketIntelLabs previously
interacted with Paperclip by executing `curl` commands the prompt template
spelled out for them — reliable-ish for reads, error-prone for writes, and
impossible to scope. The `0.7.0-mil.0` release (April 2026) ships:

- **An in-process MCP tool server** (`paperclip-mcp`, built on
  `@modelcontextprotocol/sdk@^1.29`) with four tools: `list_my_issues`,
  `get_issue`, `post_issue_comment`, `create_sub_issue`.
- **Per-run `HERMES_HOME` isolation** — each adapter run gets a fresh
  `/tmp/paperclip-run-<id>/` that symlinks real-home entries (sessions,
  skills, `.env`) but injects a per-run `config.yaml` containing an
  `mcp_servers.paperclip` block with that run's JWT + agent/company/issue
  scope. No config race between concurrent agents on the same container.
- **Scope enforcement as a security boundary** — `PAPERCLIP_ISSUE_ID`
  bounds every write. Reads stay open so agents can inspect blockers.
- **Call-explosion cap** (`MAX_TOOL_CALLS=20`) and HTTP-status retry
  classifier (`retryPolicy: retry | fix-args | abort`) so the LLM's
  failure behaviour matches the failure class.
- **Structured per-call logs** (`[paperclip-mcp-log] {...}` JSON on
  stderr) with `callId`, tool name, args, duration, and outcome.
- **A new `builtin:mil-heartbeat-v3` prompt template** that strips every
  curl example, mandates tool use, and enforces `list_my_issues` as the
  first action of a heartbeat wake.

Rollout is gated per-agent by `adapterConfig.promptTemplate`: flip one
agent to `builtin:mil-heartbeat-v3` at a time, flip back to v2 to roll
back. See the [fork divergence list](./UPSTREAM.md#divergence-from-upstream)
(item 8) for the implementation sketch.

Follow-up PR (4.1) will add MCP subprocess health checks + auto-restart
and an adapter-side curl-bypass transcript detector, once we have real
v3 transcripts to tune the thresholds against.

## MIL-specific features

Features you get in this fork that upstream doesn't ship:

- **Adapter-owned status transitions** (`builtin:mil-heartbeat-v2+`) —
  the adapter PATCHes the issue to `in_progress` before spawning Hermes
  and transitions it to the terminal status the LLM signalled via a
  `RESULT:` marker, instead of trusting the LLM to run the status
  `PATCH` itself. See [`src/server/result-marker.ts`](./src/server/result-marker.ts).
- **MCP tool server** (`builtin:mil-heartbeat-v3`, 0.7.0+) — see
  [Currently in flight](#currently-in-flight-07x) above.
- **Per-run `HERMES_HOME`** (0.7.0+) — race-free per-run configuration
  for the MCP server. See [`src/server/hermes-home.ts`](./src/server/hermes-home.ts).
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
structured per-call logging (`[paperclip-mcp-log]`), and scope enforcement.

## Development

```bash
git clone https://github.com/marketintellabs/hermes-paperclip-adapter
cd hermes-paperclip-adapter
npm install
npm run build
npm test       # 46 tests across 11 suites
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
