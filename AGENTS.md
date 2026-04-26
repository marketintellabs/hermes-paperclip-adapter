# Hermes Paperclip Adapter — Development Guide

## Overview

This is a Paperclip adapter that runs Hermes Agent as a managed employee.
It implements the `ServerAdapterModule` interface from `@paperclipai/adapter-utils`.

MarketIntelLabs maintains this fork. See [`UPSTREAM.md`](./UPSTREAM.md) for
the divergence list and sync policy, and [`README.md`](./README.md) §"Currently in flight"
for the active workstream. Current pin: **`0.8.17-mil.0`** (auto-repair detector that surfaces Hermes' silent fuzzy tool-name rewrites). Recent arc: 0.7.x MCP tool server → 0.8.x operational hardening (session-id guards, telemetry, test-mode routing, parallel `create_sub_issues`, skill preload validation, soft-timeout warning, auto-repair detector).

## Structure

```
src/
├── index.ts              # Root: type, label, models, agentConfigurationDoc
├── shared/constants.ts   # Shared constants — regex, defaults,
│                         # BUILTIN_PROMPT_TEMPLATES (mil-heartbeat{,-v2,-v3}),
│                         # ADAPTER_OWNED_STATUS_TEMPLATES, MCP_TOOL_TEMPLATES
├── server/
│   ├── index.ts          # Re-exports execute + testEnvironment
│   ├── execute.ts        # Core execution (spawn hermes CLI, pre-run claim,
│   │                     # per-run HERMES_HOME for v3, post-run reconcile)
│   ├── hermes-home.ts    # Per-run HERMES_HOME builder — symlinks real home
│   │                     # entries, writes fresh config.yaml with
│   │                     # mcp_servers.paperclip block carrying run scope
│   ├── result-marker.ts  # Parse/strip the `RESULT: done|blocked|cancelled`
│   │                     # marker the LLM emits for adapter-owned status
│   ├── run-context.ts    # Resolves per-run fields from ctx.context with
│   │                     # ctx.config fallback (buildRunContext)
│   └── test.ts           # Environment checks (CLI, Python, API keys)
├── mcp/                  # Paperclip MCP tool server (paperclip-mcp bin)
│   ├── cli.ts            # #!/usr/bin/env node — runStdioServer entrypoint
│   ├── server.ts         # buildServer: registers tools, MAX_TOOL_CALLS cap,
│   │                     # PAPERCLIP_ISSUE_ID scope binding, stderr logs
│   ├── client.ts         # fetch-based Paperclip client (loadConfig,
│   │                     # PaperclipClientError)
│   └── tools/
│       ├── index.ts          # ALL_TOOLS export
│       ├── types.ts          # ToolDef, ToolContext, ScopeViolation,
│       │                     # classifyHttp, okResult, errorResult
│       ├── list-my-issues.ts
│       ├── get-issue.ts
│       ├── post-issue-comment.ts       # scope-restricted
│       └── create-sub-issue.ts         # parent scope-restricted
├── ui/
│   ├── index.ts          # Re-exports
│   ├── parse-stdout.ts   # Hermes stdout → TranscriptEntry[]
│   └── build-config.ts   # UI form → adapterConfig
└── cli/
    ├── index.ts          # Re-exports
    └── format-event.ts   # Terminal output formatting

templates/
├── mil-heartbeat.md      # Legacy (LLM drives status via curl)
├── mil-heartbeat-v2.md   # Adapter-owned status (curl for reads/writes,
│                         # RESULT marker for status)
└── mil-heartbeat-v3.md   # MCP tool server (curl removed, MANDATORY
                          # RULES + FIRST ACTION RULE)
```

Test files sit next to their modules (`*.test.ts`). The suite has grown
from the 46-test 0.7.0-mil.0 baseline through skill preload validation,
soft-timeout, auto-repair detector (12 new tests), README ordering guard,
and other 0.8.x additions. Run `npm test` for the canonical count;
recent areas covered: scope violation, retry classifier, MAX_TOOL_CALLS,
YAML merge, symlink scheme, runId sanitization, parseHermesOutput error
detection, RESULT marker parse/strip, run-context resolution, skill
preload missing-paths, soft-timeout 80% threshold, auto-repair pattern
matching + allowlist classification, README ordering invariant.

## Key Interfaces

The adapter implements `ServerAdapterModule`:
- `execute(ctx)` — spawns `hermes chat -q "..."`, returns `AdapterExecutionResult`
- `testEnvironment(ctx)` — checks CLI, Python, API keys
- `models` — list of available LLM models
- `agentConfigurationDoc` — markdown docs for the config form

The MCP server is a separate process (`paperclip-mcp` bin) that Hermes
spawns over stdio when the resolved prompt template is in
`MCP_TOOL_TEMPLATES`. The adapter writes an `mcp_servers.paperclip` block
to the per-run `HERMES_HOME/config.yaml` so Hermes discovers it on boot.

## Build

```bash
npm install
npm run build     # tsc → dist/ (also chmods dist/mcp/cli.js for the bin)
npm run typecheck # type checking only
npm test          # runs the whole node:test suite (46 tests)
```

## Testing against a local Paperclip instance

1. Build this adapter: `npm run build`
2. In your Paperclip repo, add this as a local dependency
3. Register in `server/src/adapters/registry.ts`
4. Create an agent with `adapterType: "hermes_local"`
5. Trigger a heartbeat and observe logs

For v3 (MCP) agents, `PAPERCLIP_ISSUE_ID` in the per-run `HERMES_HOME/config.yaml`
is the security boundary: only writes to that issue are allowed; reads
anywhere are open. Scope violations surface as
`errorResult(retryPolicy=fix-args)` without touching the API.
