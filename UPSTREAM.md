# Upstream sync

This repository is a MarketIntelLabs fork of
[`NousResearch/hermes-paperclip-adapter`](https://github.com/NousResearch/hermes-paperclip-adapter),
published to npm as
[`@marketintellabs/hermes-paperclip-adapter`](https://www.npmjs.com/package/@marketintellabs/hermes-paperclip-adapter).

## Why fork?

- Upstream npm releases lag weeks behind `main` (confirmed production bugs in
  `0.3.0` were fixed on `main` Apr 3 2026 but remained unpublished as of Apr 18 2026 —
  see [issue #57](https://github.com/NousResearch/hermes-paperclip-adapter/issues/57)).
- MarketIntelLabs needs MIL-specific customizations that are unlikely to be
  generalized upstream: an embedded "MIL heartbeat" prompt template, native
  OpenRouter model-prefix detection for the `anthropic/`, `openai/`, `x-ai/`,
  `zai-org/` ecosystems we use, and a release cadence tied to our production
  deploys.
- The adapter surface is small (~1.3k LOC across `src/`) and bounded, so the
  maintenance cost of the fork is acceptable.

## Fork point

- **Upstream**: `https://github.com/NousResearch/hermes-paperclip-adapter`
- **Fork SHA**: [`937ea71`](https://github.com/NousResearch/hermes-paperclip-adapter/commit/937ea71)
  (`fix: add Authorization header to all curl examples in prompt template`,
  latest on upstream `main` at the time of fork — Apr 18 2026).

## Divergence from upstream

The MIL-specific changes live on the `mil` branch. Keep these minimal and
surgical so rebases stay tractable:

1. **Package rename + version**: `package.json` publishes as
   `@marketintellabs/hermes-paperclip-adapter` with a `0.x.y-mil.N` version suffix.
2. **MIL builtin prompt templates**: `templates/mil-heartbeat.md` (legacy —
   LLM-driven status transitions) and `templates/mil-heartbeat-v2.md`
   (0.4.0+ — adapter-owned status transitions) shipped with the package,
   plus a small loader in `src/server/execute.ts` that recognizes
   `promptTemplate: "builtin:<name>"`.
3. **OpenRouter model-prefix hints**: entries added to
   `MODEL_PREFIX_PROVIDER_HINTS` in `src/shared/constants.ts` so agents using
   OpenRouter-style model IDs (`anthropic/...`, `x-ai/...`, `openai/...`,
   `zai-org/...`) route to `provider: "openrouter"` automatically.
4. **Adapter-owned status transitions** (0.4.0-mil.0+): when the resolved
   `promptTemplate` is in `ADAPTER_OWNED_STATUS_TEMPLATES` (currently
   `mil-heartbeat-v2`), `execute.ts` PATCHes the issue to `in_progress`
   before spawning Hermes and transitions it to the terminal status the
   LLM signalled via a `RESULT:` marker in its final message (`done` /
   `blocked` / `cancelled`). The adapter also posts a structured
   completion comment. See [`src/server/result-marker.ts`](./src/server/result-marker.ts)
   and [`docs/ADAPTER_REDESIGN.md`](https://github.com/marketintellabs/marketintellabs/blob/main/docs/ADAPTER_REDESIGN.md)
   in the MarketIntelLabs infra repo for the design rationale.
   Legacy templates keep the pre-0.4.0 behaviour (LLM PATCHes status
   itself) with the 0.3.2-mil.0 safety-net reconciler still active.
5. **Runtime hardening** (0.4.1-mil.0): `parseHermesOutput` only flips
   `errorMessage` on strong failure signatures (line-start `Error:`,
   `Fatal:`, `Traceback (most recent call last):`, unhandled rejections,
   panics) instead of any stderr line containing the substring
   `error`/`failed`. The post-run `runSucceeded` guard in `execute.ts`
   now trusts only `exitCode` + `timedOut`, never `errorMessage`. Any
   `RESULT:` marker is also stripped from `summary` and `resultJson.result`
   unconditionally so the marker never leaks into Paperclip auto-comments.
   Regression driven by MAR-27 (2026-04-19), where benign stderr
   mentions of "error"/"failed" silently skipped adapter-owned status
   reconciliation and Paperclip's continuation retry then reported
   `adapter_failed`.
6. **Run-context resolution** (0.4.2-mil.0): per-run fields (`taskId`,
   `taskTitle`, `taskBody`, `commentId`, `wakeReason`, `companyName`,
   `projectName`, `workspaceDir`) are now resolved from `ctx.context`
   first, falling back to `ctx.config` for back-compat. Paperclip's
   `AdapterExecutionContext` actually carries per-run data on
   `ctx.context` (verified against `@paperclipai/adapter-utils@2026.416.0`);
   `ctx.config` is the static adapterConfig. Reading the wrong object
   made `taskId` silently undefined on modern Paperclip, which in turn
   closed the `adapterOwnedStatus && taskId && paperclipClient.apiKey`
   gate in `execute.ts` so `preRunClaim` and `reconcileOutcome` became
   no-ops (MAR-27/MAR-28 regression). The adapter now logs
   `[hermes] adapter-owned gate: …` and
   `[hermes] run context provenance: …` before dispatching the run so
   future gate closures self-diagnose without a DB dig. See
   `src/server/execute.ts::buildRunContext` + `run-context.test.ts`.
7. **Post-run safety-net reconciler** (0.3.2-mil.0): for legacy templates
   only, after a successful Hermes exit the adapter GETs the issue and
   PATCHes it to `done` if it is still `todo`/`in_progress`. Closes a
   race with upstream Paperclip's `reconcileStrandedAssignedIssues`
   watchdog.
8. **In-process MCP tool server + per-run `HERMES_HOME`** (0.7.0-mil.0):
   ships `paperclip-mcp` (stdio MCP server built on
   `@modelcontextprotocol/sdk@^1.29` and `zod@^4`) as a bin entry and a
   new `templates/mil-heartbeat-v3.md` that strips every curl example
   and mandates tool use. Four tools: `list_my_issues`, `get_issue`,
   `post_issue_comment`, `create_sub_issue`. Hardening baked in:
   `PAPERCLIP_ISSUE_ID`-based scope enforcement on writes (reads open),
   `MAX_TOOL_CALLS=20` cap, HTTP-status `retryPolicy` classifier,
   structured per-call `[paperclip-mcp-log]` logs on stderr.
   `execute.ts` gates on a new `MCP_TOOL_TEMPLATES` set (kept separate
   from `ADAPTER_OWNED_STATUS_TEMPLATES` so future templates can opt
   into either independently). When active, it builds a per-run
   `/tmp/paperclip-run-<runId>-XXXXXX/` HERMES_HOME that symlinks
   `sessions`/`skills`/`.env` from the real home (preserving session
   resume + skill discovery) but writes a fresh `config.yaml` carrying
   this run's `mcp_servers.paperclip` block with the JWT + scope env.
   Cleanup runs in `finally`.    Implementation in `src/mcp/` and
   `src/server/hermes-home.ts`. Rationale: runs are scope-distinct and
   multiple agents share a department container, so a shared
   `~/.hermes/config.yaml` would race — per-run `HERMES_HOME` is the
   clean isolation model. Also bumps Node `engines` to `>=24` to match
   the Node 24 LTS image, TypeScript to `^6.0.0`, and adds `yaml@^2.8`
   for the config generator. See
   [`docs/ADAPTER_REDESIGN.md`](https://github.com/marketintellabs/marketintellabs/blob/main/docs/ADAPTER_REDESIGN.md)
   (in the MIL infra repo) §"Phase B" for the full design record.
9. **MCP hardening** (0.8.0-mil.0): observability + trust + reliability
   pass on the 0.7.0 tool plane. Adds the `update_issue_status` tool
   (scope-enforced against `PAPERCLIP_ISSUE_ID`) so the LLM can
   transition an issue through a structured call instead of a
   `RESULT:` marker; writes a per-call NDJSON audit log to
   `$HERMES_HOME/mcp-tool-calls.ndjson` that `execute.ts` folds into
   `resultJson.toolCalls` / `toolCallCount` / `toolErrorCount`; adds a
   post-run stdout/stderr bypass detector that flips
   `errorCode: tool_bypass_attempt` when the LLM tried to `curl
   localhost:3100/api/issues/...` instead of using a tool; writes an
   MCP subprocess PID file at startup and removes it on clean exit so
   `execute.ts` can detect a stale PID and flip
   `errorCode: tool_server_died`. The `mil-heartbeat-v3` template is
   updated to prefer `update_issue_status` over the `RESULT:` marker
   (marker stays as a structured fallback). Implementation in
   `src/mcp/server.ts`, `src/mcp/tools/update-issue-status.ts`,
   `src/server/mcp-telemetry.ts`, `src/server/bypass-detector.ts`.
10. **MCP env-propagation fix** (0.8.1-mil.0): Hermes inherits process
    env into its stdio MCP subprocesses but does **not** forward the
    per-server `env` block from `config.yaml` (only a hard-coded
    allow-list like `PAPERCLIP_ISSUE_ID` that Paperclip itself sets).
    Without intervention, `PAPERCLIP_MCP_AUDIT_LOG` /
    `PAPERCLIP_MCP_LIVENESS_FILE` resolved to `undefined` inside the
    MCP server and the NDJSON + liveness files were never written, so
    every 0.8.0 run reported `toolCallCount=0`, `audit=false`,
    `liveness=false` regardless of what the LLM actually did.
    `execute.ts` now sets both env vars directly on the Hermes child
    process env so they propagate via normal inheritance. Fix verified
    against MAR-30 heartbeat telemetry.
11. **Session-id poisoning guard** (0.8.2-mil.0): the legacy
    non-quiet-mode `SESSION_ID_REGEX_LEGACY` used to be
    `/session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i`, which
    false-matched the phrase `"session ID from"` in Hermes' own
    resume-failure prose (`"Session not found: from\nUse a session ID
    from a previous CLI run."`) and captured the literal word `"from"`
    as a session id. The adapter returned it, Paperclip persisted it
    as `session_id_after`, the next heartbeat replayed
    `--resume from`, Hermes crashed, the adapter re-extracted
    `"from"` — infinite crash loop. Fix is defense-in-depth: anchor
    the legacy regex to `session_id:` / `session saved:` with a
    mandatory colon, shape-validate every captured token via the new
    `isPlausibleSessionId` helper (min length 8, must contain a
    digit/hyphen/underscore — rejects `"from"`, `"session"`, etc.),
    and skip session-id extraction entirely when the output contains
    `"Session not found"` or `"Use a session ID from a previous CLI
    run"`. Nine new tests in `parse-hermes-output.test.ts` pin the
    regression. Incident reference: MAR-30 Marcus heartbeat crash
    loop, 2026-04-19.
12. **Resume guard + config.yaml diagnostic** (0.8.3-mil.0): two small
    follow-ups to 0.8.2. (a) `resolveResumeSessionId` runs
    `isPlausibleSessionId` on the stored `sessionParams.sessionId`
    before it becomes `hermes chat --resume <id>`; if some OTHER
    store (Hermes SQLite state, paperclip cache) still holds a
    poisoned value we drop it, log a warning, and create a fresh
    session. (b) After writing the per-run `config.yaml` the adapter
    reads it back and logs `audit=<bool> liveness=<bool>` so
    `stdout_excerpt` alone reveals whether the telemetry env block
    made it onto disk — needed because Hermes' `_build_safe_env`
    (`tools/mcp_tool.py`) intentionally filters parent env down to
    a small allowlist, so the process-env write from 0.8.1 was a
    no-op. 0.8.1's belt-and-suspenders lines are removed, with a
    comment explaining why, to keep future maintainers from
    re-adding them. Six new tests in `parse-hermes-output.test.ts`
    cover `resolveResumeSessionId`.
13. **`adapterVersion` in resultJson** (0.8.4-mil.0): every run records
    the adapter version into `resultJson.adapterVersion`, sourced from
    a new canonical `src/shared/version.ts` that both the MCP server
    banner and `execute.ts` import from. Needed during rollouts and
    hot-patches to tell at a glance which adapter produced a given
    run — `stderr_excerpt` is truncated past the MCP startup banner in
    most Paperclip runs, so the banner version was effectively
    invisible. Zero-risk addition (pure read), no changes to existing
    fields.
14. **Release workflow**: `.github/workflows/release.yml` publishes to npm on
    tag push.

Everything else is expected to stay in lockstep with upstream.

## Sync policy

- **Cadence**: rebase or merge from upstream `main` at least once a quarter,
  or within 7 days of any upstream release.
- **Process**:
  ```sh
  git remote add upstream https://github.com/NousResearch/hermes-paperclip-adapter
  git fetch upstream
  git checkout main
  git rebase upstream/main   # prefer rebase; merge if the MIL delta is large
  pnpm install && pnpm build && pnpm typecheck
  git tag v0.X.Y-mil.Z && git push --tags
  ```
- **When fixes are generalizable**, open a PR against upstream first
  (we already submitted the [issue #57 fix](https://github.com/NousResearch/hermes-paperclip-adapter/issues/57)
  via upstream commits `f4e2457` + `937ea71`).

## Retirement criteria

Retire this fork and go back to consuming upstream directly when **all** of
these are true:

1. Upstream cuts releases within 14 days of merged fixes.
2. The MIL-specific builtin prompt template can be expressed purely through
   `adapterConfig.promptTemplate` without a packaged file (e.g. via a Paperclip-
   side template registry).
3. The OpenRouter model-prefix hints we add land upstream.

If/when we retire, the `paperclip/Dockerfile` `pnpm.overrides` block can be
removed, and `server/package.json` can depend on the upstream package directly.

## License

MIT, inherited unchanged from upstream. See [`LICENSE`](./LICENSE).
