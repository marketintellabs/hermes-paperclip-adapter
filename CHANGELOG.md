# Changelog

All notable changes to the `@marketintellabs/hermes-paperclip-adapter` fork are documented here. The canonical source of release notes is the [GitHub Releases page](https://github.com/marketintellabs/hermes-paperclip-adapter/releases), which is what npmjs.com surfaces on the package page.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/) with the `-mil.N` prerelease suffix marking MIL fork releases.

## [0.9.7-mil.0] — 2026-05-30

### Changed
- **Per-tier free-model defaults re-baselined from a live smoke test — picked for AVAILABILITY, not just spec'd latency.** 0.9.6 picked free slugs from model specs (deepseek-v4-flash / qwen3-next / gemma-4). A live tool-call smoke test against OpenRouter's free tier (`tmp/free-model-smoketest.py`, 2026-05-30) showed those "fast" models are essentially **always 429'd upstream** (the popular free slugs are globally saturated) — fast on paper, unavailable in practice. The test scored models on availability + tool-call success + latency over repeated trials. The only free models that were *reliably available AND reliably emitted tool calls* were the OpenAI `gpt-oss` family and `z-ai/glm-4.5-air`. New defaults:
  - `super` → `openai/gpt-oss-120b:free` (8/8 available, 8/8 tool calls, med 3.2s, p90 6.3s — most reliable)
  - `nano` → `openai/gpt-oss-20b:free` (fastest median 2.6s, light, high-volume aux)
  - `opus`, `quality` → `z-ai/glm-4.5-air:free` (8/8 available, med 5.4s)
  - `glm` → `openai/gpt-oss-120b:free`
  - `FALLBACK_FREE_MODEL` → `openai/gpt-oss-120b:free`
- **Confirmed the NVIDIA failure mode that motivated all this.** `nvidia/nemotron-nano-9b-v2:free` measured ~12s/run and emitted **zero** tool calls across trials — exactly the prod symptom. (Notably the *larger* nemotrons, `3-nano-30b` / `3-super-120b`, were fine; the meta-router's problem was landing on the small one at random.)
- **No API/contract change** — only the slug constants moved. `super` and `nano` still resolve to different slugs (rate-limit spread); all override precedence and `production`-is-identity behaviour unchanged.

## [0.9.6-mil.0] — 2026-05-30

### Changed
- **Free models are now pinned per-tier to fast, tool-calling slugs — no more `openrouter/free` meta-router.** The 0.9.5 default routed freed tiers through OpenRouter's `openrouter/free` meta-router, which selects a free model *at random* from the whole free pool. In practice that regularly landed on the slow NVIDIA Nemotron free endpoints (`nvidia/nemotron-3-nano-*`, `nvidia/nemotron-3-super-*`) — unacceptable response times for an agent that makes many sequential MCP tool calls per run. `src/server/openrouter-mode.ts` now maps each tier to a specific fast free model (`DEFAULT_FREE_MODELS_BY_TIER`), chosen for low latency (few-active-param MoE / "flash" / "low-latency" tiers) and verified live against OpenRouter's `?supported_parameters=tools` model list:
  - `super` → `deepseek/deepseek-v4-flash:free` (13B-active flash MoE, 1M ctx, native tools)
  - `nano` → `openai/gpt-oss-20b:free` (3.6B-active, "lower-latency", tools + structured outputs)
  - `opus` → `qwen/qwen3-next-80b-a3b-instruct:free` (3B-active MoE, structured outputs)
  - `quality` → `google/gemma-4-31b-it:free` (4B-active, native function calling)
  - `glm` → `openai/gpt-oss-120b:free` (strongest free reasoning, native tools)
- **The two high-volume freed tiers (`super`, `nano`) are deliberately on *different* models.** OpenRouter free rate limits are per-model (~200 req/day with no credits, 1000 with $10+), so co-locating every agent on one free slug would exhaust that model's daily cap and stall the fleet during testing. `hybrid` spreads across two models; `free_only` spreads all five tiers across five models.
- **Per-tier runtime override added.** `OPENROUTER_FREE_MODEL_<TIER>` (e.g. `OPENROUTER_FREE_MODEL_SUPER`, `OPENROUTER_FREE_MODEL_NANO`) overrides a single tier; the existing global `OPENROUTER_FREE_MODEL` still pins all freed tiers. Resolution order: per-tier env → global env → per-tier default → `FALLBACK_FREE_MODEL` (`deepseek/deepseek-v4-flash:free`). All overrides are env-only (no rebuild).
- `production` remains identity (no behaviour change at deploy). +9 net tests (`openrouter-mode.test.ts`: 22 → 31).

## [0.9.5-mil.0] — 2026-05-30

### Added
- **`OPENROUTER_MODE` model toggle — `production | hybrid | free_only`.** New `src/server/openrouter-mode.ts` generalises the binary `test-mode.ts` override into a process-wide, env-controlled mode that maps each agent's *tier* to a model. The tier is read from `adapterConfig.modelTier` (set by `paperclip/configure-agents.mjs`).
  - `production` (default) — identity; every agent runs its configured paid model. **Deploying this release is a no-op until an operator sets `OPENROUTER_MODE` and redeploys.**
  - `hybrid` — keep `opus`/`quality`/`glm` paid; route the high-volume `super` + `nano` worker tiers to the free model. A missing/unknown tier stays **paid** (fail-safe: never silently downgrade a reasoning agent).
  - `free_only` — every tier routes to the free model (dev/full-system validation only).
  - **Free model** defaults to OpenRouter's `openrouter/free` meta-router and is overridable **at runtime** via `OPENROUTER_FREE_MODEL` (set on the ECS task definition — no adapter rebuild needed) to pin a specific free slug or alternative meta-router.
  - **Precedence:** test-mode (env big-hammer / per-issue marker) wins over `OPENROUTER_MODE`, which wins over the configured paid model — smoketest routing is never disturbed.
  - **Observability:** each overridden spawn logs a grep-able `[hermes] *** OPENROUTER_MODE=<mode> *** … tier=… model=<orig>-><free> …` banner; `result_json.providerSource` records `openrouter-mode:<mode>`; the "Starting Hermes Agent" line carries the same source tag. An unrecognised `OPENROUTER_MODE` value logs a WARN and falls back to production.
  - When a tier is freed, all auxiliary slots (compression / vision / session_search / title_generation) are forced to the free model too, matching test-mode behaviour.
  - **No auto-fallback yet.** A `429 → paid` retry in `hybrid` is a planned fast-follow, gated on confirming the 429 is detectable in the spawn path (Hermes runs `-Q` quiet). +22 tests (`src/server/openrouter-mode.test.ts`).

## [0.9.4-mil.0] — 2026-05-03

### Fixed
- **Release-hygiene: `ADAPTER_VERSION` constant ↔ `package.json` version drift.** `src/shared/version.ts` exports the canonical runtime version constant that gets emitted in `result_json.adapterVersion` (every heartbeat run), the MCP server connection banner, and `runHealthCheck()` output. This constant was last touched in 0.9.1-mil.0 and accidentally **not bumped** in either 0.9.2-mil.0 (PR #32) or 0.9.3-mil.0 (PR #33). The published npm packages were correct, the deployed images were correct, the new behaviour (terminal-state guard + anti-hallucination prefixes) was live in production — but every run on the fleet was reporting `adapterVersion: "0.9.1-mil.0"` for ~12 hours, and `bake-spotcheck.mjs` / `check-pilot.mjs` would have flagged the entire fleet as on the old adapter forever. 0.9.4 bumps the constant.
- **CI guard against a recurrence.** New `src/shared/version.test.ts` asserts `ADAPTER_VERSION === require('../package.json').version` and asserts the constant follows the `MAJOR.MINOR.PATCH-mil.N` prerelease shape. The release workflow now runs `npm test` before `npm publish`, so the test runs on every tag push. The version.ts docstring already claimed "the release workflow checks this at publish time" — that claim is now true.
- **Release workflow tag-vs-package-json guard.** New step in `.github/workflows/release.yml` asserts the pushed tag (`v<x.y.z-mil.N>`) matches `package.json` before publishing. Prevents a hand-crafted tag from publishing a different version than the tag implies.

### Notes
- **Behaviour-only release; no runtime code change.** All the 0.9.2 and 0.9.3 features are already live in production from the 2026-05-03 18:37 UTC deploy — what was wrong was the self-reported version number, not the running code. Once 0.9.4 deploys, telemetry catches up to reality.
- **Test count: 401 → 411** (8 net-new from 0.9.3's `types.test.ts` + `server.test.ts` already counted in the prior baseline; 0.9.4 adds 2 in `version.test.ts`).

## [0.9.3-mil.0] — 2026-05-03

### Fixed
- **Anti-hallucination clarity on tool-error classification.** Every tool error now leads with one of three policy-keyed prefixes: `[ARGS REJECTED — MCP server is healthy; your call arguments did not match the tool's schema. Read the message below, fix the offending field, and retry the same tool. Do NOT conclude the server is unreachable.]` for `fix-args`; `[TRANSIENT FAILURE — …]` for `retry`; `[NON-RECOVERABLE — …]` for `abort`. The "MCP server is healthy" anchor on `fix-args` is the load-bearing phrase — pre-empts the unreachable-server hallucination by stating the contrary frame inside the error body the LLM reads. Same vocabulary in every error path: `errorResult()` (used by all tools), the in-handler tool-call-limit-exceeded path, the in-handler internal-error catch, and the new SDK-validation interceptor below.
- **MCP-SDK-level zod validation rejections now also flow through the prefix.** Previously these bypassed `errorResult()` entirely — the SDK's `validateToolInput` throws an `McpError(InvalidParams)` BEFORE the per-tool execute() runs, and the SDK converts it via `createToolError` into a raw `Invalid arguments for tool …` result with no `[retryPolicy=…]` tag and no prefix. New `installValidationErrorReformatter` in `src/mcp/server.ts` re-sets the SDK's `tools/call` request handler with a wrapper that delegates to the SDK's logic and post-processes its return value: when the result text matches the `Invalid arguments for tool …` shape, the wrapper reformats it with the `fix-args` prefix and a `[retryPolicy=fix-args]` tag, and emits a `tool_call_validation_rejected` log event. Already-prefixed in-tool errors are detected by their leading bracket and pass through unchanged (no double-wrapping).

### Notes
- **No wire-format breakage.** Every error response keeps its `isError: true` and its trailing `[retryPolicy=…]` tag — substring-based downstream parsers continue to work. The prefix is additive context.
- **Motivated by an observed run-time hallucination.** The 2026-05-03 post-mortem of an agent run found three consecutive `post_issue_interaction` schema-validation rejections being collapsed into a single hallucinated diagnosis ("the MCP server appears unreachable") despite the server reporting `healthy` and durations consistent with an in-process zod rejection. The classification was correct (these were args-validation failures the LLM should have retried with corrected args) but the error text was indistinguishable from a network failure to the LLM's NLU. The leading `[ARGS REJECTED — MCP server is healthy …]` anchor closes that gap.

## [0.9.2-mil.0] — 2026-05-03

### Fixed
- **Terminal-state guard on `update_issue_status`.** The tool now reads the issue's current status before issuing the PATCH and refuses to transition out of `cancelled` or `done`. An idempotent re-assert (e.g. `done` → `done`) is allowed and short-circuits to the PATCH. The error result returns `retryPolicy=abort` with a clear message instructing the agent to look for new work via `list_my_issues`. If the precheck read itself fails the guard logs and falls through, so a transient backend hiccup never blocks a legitimate transition.
- **9 new unit tests** in `update-issue-status.test.ts` covering the guard's positive and negative paths plus the precheck-read-failure fallthrough; existing `tools.test.ts` cases updated to stub the new GET.

### Notes
- **Defense-in-depth, not a behaviour change for healthy runs.** Normal transitions (`in_progress` → `done`, `in_progress` → `blocked`, `in_progress` → `needs_review`) cost one extra GET (~50–150ms once at run end) and behave identically.

## [0.9.1-mil.0] — 2026-05-02

### Added
- **Structured classification of provider failure modes** in `result_json`. New `src/server/llm-error-classifier.ts` inspects each run's final-message text and emits a stable `errorCode` plus an operator-actionable hint: HTTP 402 → `provider_budget_exhausted`; 401/403 → `provider_auth_failed`; 429 → `provider_rate_limited`; generic "failed after N retries" → `llm_call_exhausted_retries`. Provider is detected from URL signatures with a config fallback.
- **Wired into `src/server/execute.ts`** so a classification sets `errorCode`/`errorEvidence`, records an actionable hint, and marks the run dead or stalled appropriately.
- **18 new unit tests**. Total adapter test count: 373 → 391.

### Notes
- **Pure additive.** Successful runs return `null` from the classifier and proceed exactly as before.

## [0.9.0-mil.0] — 2026-05-02

### Added
- **New builtin prompt template `mil-heartbeat-v4`** (`templates/mil-heartbeat-v4.md`). Same adapter-owned status semantics and same in-process `paperclip-mcp` tool server as `mil-heartbeat-v3`, with two differences: (a) retires the `RESULT:` marker from the prompt surface — the parser still honours it server-side as a fallback during rollout, but v4 agents are taught `mcp_paperclip_update_issue_status` as the canonical completion signal; (b) documents the BETA `mcp_paperclip_post_issue_interaction` tool with worked examples for each currently-shipping kind (`request_confirmation`, `suggest_tasks`, `ask_user_questions`) and explicit guidance on when NOT to use it.
- **Registration in `BUILTIN_PROMPT_TEMPLATES`, `ADAPTER_OWNED_STATUS_TEMPLATES`, and `MCP_TOOL_TEMPLATES`** in `src/shared/constants.ts`. v3 and v4 are both supported indefinitely so consumers can flip agents one at a time.
- **One new unit test in `resolve-prompt-template.test.ts`** that resolves `builtin:mil-heartbeat-v4`, asserts each documented `IssueInteraction` kind appears in the rendered template, and asserts the `RESULT:` marker has been retired from the prompt surface. Total adapter test count: 372 → 373.

### Notes
- **No wire-format breakage, no Hermes-arg change, no MCP tool surface change.** Opt-in per agent via `adapterConfig.promptTemplate = "builtin:mil-heartbeat-v4"`. Agents not flipped continue to render v3 with identical run behaviour.
- **The RESULT-marker parser is retained server-side.** `src/server/result-marker.ts` keeps parsing markers in run output as a fallback completion signal so v3-pinned agents and v4 agents that occasionally emit a marker don't dead-end. Removal can land in a future release once the marker stops appearing in `result_json.toolCalls[]`.

## [0.8.21-mil.0] — 2026-05-02

### Added
- **`post_issue_interaction` MCP tool — opt-in writer for Paperclip v2026.428.0's structured `IssueInteraction` records (BETA upstream API).** New `src/mcp/tools/post-issue-interaction.ts` exposes `POST /api/issues/:id/interactions` as a typed MCP tool. Supports the three currently-shipping kinds: `suggest_tasks`, `ask_user_questions`, and `request_confirmation`. Tool input mirrors upstream's `createIssueThreadInteractionSchema`; the run id is threaded through `sourceRunId` automatically (read from `process.env.PAPERCLIP_RUN_ID`). The tool is registered in the global registry but NOT in any agent's default allowlist — agents only get it when their `paperclipMcpTools` config includes the name explicitly.
- **Per-tool error classification — fix-args / retry / abort.** `4xx` validation failures (with the upstream zod issue body forwarded into the tool result text) → `retryPolicy=fix-args`; `5xx` and bare network errors → `retryPolicy=retry`; `401`/`403` → `retryPolicy=abort`.
- **22 new unit tests** in `post-issue-interaction.test.ts`: per-kind round-trips, optional-field threading (`idempotencyKey`, `title`, `summary`, `continuationPolicy`), `sourceRunId` injection from `PAPERCLIP_RUN_ID`, scope-violation rejection, and the full HTTP-status classification matrix. Total adapter test count: 360 → 372.

### Notes
- **Wire-format additive only.** No prompt-template change, no Hermes-arg change. The new tool only fires when both (a) the agent's `paperclipMcpTools` lists `post_issue_interaction`, and (b) its prompt explicitly invokes it.
- **BETA upstream surface — defensive coding.** Only emits the kinds and payload shapes Paperclip v2026.428.0 accepts. Any 4xx response is forwarded verbatim to the LLM so a contract shift surfaces as a fixable validation error.

## [0.8.20-mil.0] — 2026-05-02

### Added
- **Run-liveness telemetry — adopts the structured shape introduced upstream by Paperclip v2026.428.0 (#4083).** New `result_json` fields on every Hermes run: `livenessState` (`active` / `stalled` / `dead`), `progressBeats[]` (chronological structured events with ISO timestamps), and `nextActionHints[]` (deduped, sorted operator-actionable suggestions). Implementation lives in `src/server/liveness.ts` as a self-contained `LivenessTracker` class with a clean state machine — `markStalled()` is idempotent (only promotes from `active`), `markDead(reason)` is sticky, and `recordHint(hint)` dedupes via a `Set`. Hooks fire from existing observation points in `execute.ts`: the soft-timeout callback marks `stalled` and beats `soft_timeout_reached`; each retry attempt beats `retry_triggered`; the MCP-died telemetry block calls `markDead("mcp_subprocess_died")`; `result.timedOut` calls `markDead("hard_timeout")`. The terminal `run_end` beat is recorded last. The preflight skip path lands consistent shape with a single `preflight_skipped` beat.
- **Optional `adapterConfig.livenessHeartbeatSec` config — periodic `heartbeat_tick` beats while the child is alive.** Default off. When set to a positive number (clamped to a 5-second floor), the tracker emits a `heartbeat_tick` beat every N seconds with `detail=elapsed=<sec>s`. The interval is `unref()`d so it never holds the event loop open past `stopHeartbeat()`, which is invoked in the `runChildProcess` `finally` block.
- **18 new unit tests** in `liveness.test.ts` covering tracker default state, ISO timestamps, hint dedupe, state-machine transitions, idempotent start/stop heartbeat, and integration shapes for typical successful / soft-timeout / MCP-crash / hard-timeout-supersedes-stalled runs. Total adapter test count: 342 → 360.

### Notes
- **No wire-format breakage, no prompt-template change, no Hermes-arg change.** Purely additive on `result_json`. Same MCP tool surface, same builtin templates. Safe rolling deploy.
- **Paperclip-side liveness watchdog is already running in production (v2026.428.0).** This release adds the run-side companion fields so the upstream watchdog has structured client observations to correlate with. The optional `livenessHeartbeatSec` is a forward-looking knob — when upstream's liveness endpoint shape stabilises out of BETA, a future release will gain an HTTP emitter.

## [0.8.19-mil.0] — 2026-05-02

### Fixed
- **`resolvePromptTemplate` is now robust to wrapper-prepended input — required for Paperclip v2026.428.0+ compatibility.** Paperclip v2026.428.0 added an `authGuardPrompt` wrapper around its in-tree `hermes_local` adapter that PREPENDS a four-line block to `adapterConfig.promptTemplate` before passing it through to `execute()`. The wrapper turns a canonical `"builtin:mil-heartbeat-v3"` value into multi-line input that fails the `raw.startsWith("builtin:")` check at the top of `resolvePromptTemplate`. Pre-0.8.19 the function silently fell into "raw template" mode on any wrapper-prepend: `builtinName` returned `null`, which meant the run lost adapter-owned status transitions, the per-run `paperclip-mcp` tool server, AND Mustache `{{var}}` substitution. The new `loadBuiltinTemplate` helper splits resolution into two paths: (a) **strict legacy** for single-line `builtin:<name>` input — throws on unknown names; (b) **wrapper-prepend defense** for multi-line input — scans every line for a `builtin:<known-name>` reference, first match wins.
- **`resolvePromptTemplate` and `ResolvedTemplate` are now exported from `src/server/execute.ts`.** Previously private; tests now exercise them directly via `src/server/resolve-prompt-template.test.ts` (14 cases).

### Notes
- **Pure defense — no wire-format, prompt-template, or run-behaviour change for clean bare `builtin:<name>` input.** Path A returns identical bytes to pre-0.8.19.
- 14 new unit tests; total adapter test count: 328 → 342.

## [0.8.18-mil.0] — 2026-04-26

### Added
- **Retry-with-backoff on transient LLM failures.** `runChildProcess` is now wrapped in a retry loop driven by a conservative classifier (`src/server/retry-policy.ts`). Strong upstream-blip markers (HTTP 429, 5xx, `overloaded_error`, `rate_limit_error`, `provider overloaded`, gateway timeouts, ECONNRESET, ETIMEDOUT) trigger a sleep of `retryBackoffSec` (default 30s), a `[hermes] retrying after transient failure …` notice, and a respawn. Hard timeouts and SIGKILLs are explicitly classified as **permanent**. Default budget is **one** retry; tunable via `retryMaxAttempts` (clamped to 3) and `retryBackoffSec` (clamped to 600). Disable with `retryOnTransient: false`. Each retry is recorded in `result_json.retries[]` plus a `retryAttempts` counter that's always present. The classifier requires *strong* markers — not just the word "rate" — to avoid infinite loops on permanent bugs.
- **`maxTranscriptEntries` config — opt-in cap on `ctx.onLog` chunks per run.** Above the cap, further LLM-output chunks are suppressed and a single `[hermes] transcript truncated: cap=N reached …` notice is emitted. Adapter-emitted `[hermes] *` lines (banner, exit code, telemetry, soft-timeout, retry notices) ALWAYS bypass the cap. `result_json.transcriptObserved`, `transcriptSuppressed`, and `transcriptTruncated` make the cap's effect inspectable. Default `0` (unlimited) preserves pre-0.8.18 behaviour.
- **Runtime health-check CLI: `paperclip-hermes-health`.** New bin entry runs four probes and prints structured JSON: hermes-binary on PATH, `$HERMES_HOME` writable (real `mkdtemp` test), `state.db` opens cleanly via `node:sqlite`, OpenRouter reachability via unauthenticated `GET /api/v1/models` with a 5s `AbortSignal.timeout`. Exit codes: `0` pass, `1` fail, `2` warn. Flags: `--no-network`, `--pretty`, `--hermes-home`, `--hermes-cmd`. Check codes are stable across patch releases.
- **30 new unit tests** across `retry-policy.test.ts`, `transcript-cap.test.ts`, `env-unwrap.test.ts`, and `health-check.test.ts`. Total adapter test count: 328 → 358.

### Fixed
- **Env-var unwrap regression — cherry-picked from upstream NousResearch PR #29.** Pre-0.8.18 `Object.assign(env, userEnv)` copied Paperclip's `{ type, value }` secret-ref wrappers verbatim, so spawned Hermes saw `[object Object]` for any key set via `adapterConfig.env`. Replaced with `unwrapUserEnv` (`src/server/env-unwrap.ts`) that handles plain strings, `{ value }` wrappers, and tracks anything weird in a `droppedKeys` array surfaced as a single `[hermes] WARN: dropped N adapterConfig.env entries …` line per run. Credit @lucasproko for the original report.

### Notes
- **Wire-format additions are all additive.** `result_json` gains `retries`, `retryAttempts`, and (when the cap is set) `transcriptCap` / `transcriptObserved` / `transcriptSuppressed` / `transcriptTruncated`. Downstream consumers that ignore unknown keys keep working unchanged.
- **`ADAPTER_VERSION` was stale at `0.8.16-mil.0` for two releases (0.8.16-mil.1 and 0.8.17-mil.0). Bumped to 0.8.18-mil.0 in this release.** `result_json.adapterVersion` will now correctly report 0.8.18 on every run.

## [0.8.17-mil.0] — 2026-04-26

### Added
- **Auto-repair detector — surfaces Hermes' silent fuzzy tool-name rewrites as loud stderr alarms.** Hermes Agent's tool-call parser fuzzy-matches every emitted `<TOOLCALL>` block: if the LLM names a tool that doesn't exist exactly, Hermes silently rewrites the call to the closest-matching registered tool, prints a single `🔧 Auto-repaired tool name: 'X' -> 'Y'` line, and dispatches the rewritten call. The new detector watches the Hermes stdout/stderr stream for that signature and (1) emits a `[hermes] ERROR: auto-repair: Hermes silently rewrote 'X' → 'Y'; …` line on **stderr** at the moment of detection, and (2) when the agent has a `paperclipMcpTools` allowlist, classifies whether the *original* tool name was authorised for this agent — message says either "ORIGINAL tool was NOT in the per-agent allowlist" or "original tool IS in the per-agent allowlist (likely typo or near-miss)". Every detection is also recorded in `result_json.autoRepairs[]` plus rollup counters `autoRepairCount` and `autoRepairUnauthorizedCount`. Disable via `adapterConfig.autoRepairAlerts = false`. The detector does NOT abort the run.
- **12 new unit tests** in `auto-repair-detector.test.ts`: benign-chunk steady state, original/repaired extraction, multi-line / CRLF tolerance, unauthorized-vs-near-miss classification, both bare and namespaced (`mcp_paperclip_…`) allowlist forms, opt-out flag, message wording across classification states, and a false-positive guard.

### Notes
- **No wire-format or prompt-template change.** Pure observability addition.
- **Why this lives in the adapter, not in Hermes.** Hermes' fuzzy matcher runs *before* the call ever reaches the adapter's MCP server, so the original intent is gone by the time the call lands. The adapter cannot intercept the rewrite, but it CAN tee Hermes' announcement of the rewrite into a structured signal.

## [0.8.16-mil.1] — 2026-04-26

### Changed
- **README ordering fix.** The "Currently in flight (0.8.x)" section in the README listed entries out-of-order. Re-sorted so every entry now appears in ascending version order, matching how the section was originally laid out and how npmjs.com renders the package page top-to-bottom. Same shape of regression as `0.8.8-mil.2` and `0.8.11-mil.1`; this release adds a CI-enforceable guard so it stops happening.

### Added
- **`src/shared/readme-order.test.ts` — automated guard against the recurring out-of-order regression.** Two tests run on every CI build: (1) parses every `**X.Y.Z-mil.N — ` header in `README.md` and asserts the (X, Y, Z, N) tuples are monotonically non-decreasing; (2) cross-checks `package.json.version` against the latest README header to catch missed entries. Both tests fail loud with actionable error messages.

### Notes
- Docs-only release. No code changes from `0.8.16-mil.0`.
- Republished to npm so the package page picks up the corrected README. (npm only re-renders the README on a fresh publish.)

## [0.8.16-mil.0] — 2026-04-26

### Added
- **`create_sub_issues` (plural) MCP tool — bulk parallel delegation.** Existing `create_sub_issue` is preserved unchanged; the new plural form takes one shared `parentIssueId` plus an array of `subIssues` (capped at 10 per call) and POSTs them via `Promise.allSettled`. Three wins for delegators: (1) one MCP-call-budget unit per batch regardless of fan-out width; (2) parallel fan-out collapses N sequential RTTs into one bounded by the slowest child; (3) partial-failure semantics — one transient 503 cannot sink siblings, and the LLM gets a per-item outcome array with per-index `retryPolicy`. Aggregate retry policy is escalated to `fix-args` if ANY child saw a 4xx in an all-failure case. Test-mode marker inheritance is applied per child (idempotent). The wire-shape contract — `parentId` (NOT `parentIssueId`), explicit `status: "todo"` — lives in one shared `buildPayload` helper.
- **Updated prompt template `builtin:mil-heartbeat-v3`** to advertise both tools with explicit guidance on when to use the bulk form. Minor copy update only.
- **11 new unit tests** in `create-sub-issues.test.ts`: happy path with N children, partial failure, all-failure aggregate policy escalation, missing parent / company id, scope-violation rejection, runtime over-cap defense, and test-mode marker prepend / idempotency.

### Fixed
- **`npm test` now actually runs all test files.** The previous test script `node --test dist/**/*.test.js` relied on `**` globstar which is NOT enabled by default in `sh`. The pattern silently expanded to skip every test file three levels deep. Quoting the glob (`'dist/**/*.test.js'`) hands the pattern to `node --test`'s native glob expansion, which DOES recurse. Test count jumped from 224 → 278 with no other code changes.

### Notes
- **No wire-format or run-behaviour change.** The plural tool is purely additive. Allowlist gate (`paperclipMcpTools`) is the same `can_delegate` policy: agents that already have `create_sub_issue` need to be reconciled to also include `create_sub_issues`.
- **One MCP-call-budget unit per batch** is enforced inside the MCP server. The 20-call cap stays exactly where it was.
- **`Promise.allSettled`, not `Promise.all`** is the deliberate choice. The settled outcome array preserves the per-child retry decision in the LLM's hands.

## [0.8.15-mil.0] — 2026-04-26

### Added
- **Skill preload validation at run start.** `execute()` now stat()s every path declared in `adapterConfig.hermes_skill` and `adapterConfig.hermes_skills` against the resolved skills root (`HERMES_SKILLS_DIR`, default `/data/hermes/skills`). Each declared-but-missing skill produces a `[hermes] WARN: skill "<ref>" declared … but not found at <abspath> — Hermes will run WITHOUT this skill` line on stderr, plus a single rollup `[hermes] skills validated: N/M present, K MISSING` line. The validator is purely diagnostic — never fatal — and is wired in BEFORE pre-flight so the warning lands even on no-op wakes.
- **Soft-timeout warning at 80% of `timeoutSec`.** `execute()` schedules a one-shot `setTimeout` after the child spawns. When fired, it emits `[hermes] WARN: soft-timeout reached at <N>s (80% of <T>s hard limit). Run still in progress; consider raising adapterConfig.timeoutSec if this becomes routine.` to stderr. Skipped if `timeoutSec ≤ 0`, if the warning would fire below a 5-second floor, or if the operator opts out via `adapterConfig.softTimeoutWarn=false`. Threshold tunable via `adapterConfig.softTimeoutThreshold`. The timer is unref()d and cleared in the same `finally` block that runs MCP telemetry collection.
- 14 new unit tests across `validate-skills.test.ts` and `soft-timeout.test.ts`.

### Notes
- **No wire-format or prompt-template change.** Both additions are observability-only.
- **No interaction with the hard timeout.** The hard timeout in `runChildProcess` (`timeoutSec` + `graceSec`) still owns SIGTERM / SIGKILL of a hung child; the soft warning is purely informational.
- **Skill validation is best-effort I/O.** A flaky mount won't break a run.

## [0.8.14-mil.0] — 2026-04-25

### Added
- **`resultJson.modelUsed` / `provider` / `providerSource` are now populated on every successful run.** Telemetry queries can answer "which model did this agent run on?" directly from `result_json` instead of grepping `stderr_excerpt`. Values come from the adapter's own model/provider resolver. `providerSource` is `hermesConfig` for the configured route or `test-mode-override` when per-run test mode is winning.
- **`resultJson.result_marker_present` (canonical name) for the agent's `RESULT:` marker.** `true` when the agent's final message contained a `RESULT: done|blocked|cancelled` marker, `false` otherwise.

### Changed
- **`resultJson.marker_present` is now a deprecated alias of `result_marker_present`.** The old name was misleading because operators reasonably read it as "test-mode marker present" (`<!-- mode: test -->`), which is a different concept. Both fields will hold the same boolean; the alias will be removed in `0.9.0`.

### Notes
- **`resultJson.cost_usd` remains `null` for successful runs against Hermes Agent v0.9.0 (`v2026.4.13`).** Not a regression — the upstream Hermes Agent does not emit cost or token-usage lines in stdout/stderr in quiet mode. A future release will call OpenRouter's `GET /api/v1/generation` after the run completes to backfill `cost_usd` / `usage`.
- **No prompt-template change.** This is a `result_json` shape change only. Safe rolling deploy.

## [0.8.13-mil.0] — 2026-04-25

### Fixed
- **`create_sub_issue` no longer creates orphaned children.** The adapter sent `parentIssueId` in the POST body; Paperclip's `POST /companies/:id/issues` schema uses the column-aligned name `parentId` and silently drops unknown fields, so every sub-issue landed with `parent_id = NULL`. Now the payload uses `parentId`, with a regression test asserting the wire shape so the field name can't drift.
- **Delegated sub-issues now wake the assignee immediately.** The same POST was missing a `status` field, so Paperclip defaulted it to `backlog`, which does not fire the assignee's `on_assign` heartbeat. The adapter now explicitly sends `status: "todo"`.

### Added
- One regression test (`payload contract: parentId + status=todo even when test mode + priority unset`) and four new assertions on the existing happy-path test, all locking the wire-level field names.

### Notes
- **No prompt-template change.** This is a wire-format fix in the MCP tool layer; the LLM-facing tool input schema still uses `parentIssueId` as a descriptive parameter name.

## [0.8.12-mil.1] — 2026-04-25

### Changed
- **README updated to include the 0.8.12 entry.** The 0.8.12-mil.0 tarball shipped without a "Currently in flight" entry for itself, so the npmjs.com package page still listed 0.8.11-mil.0 as the most recent feature. Republished so npm re-renders the README.

### Notes
- Docs-only release. No code changes from `0.8.12-mil.0`.

## [0.8.12-mil.0] — 2026-04-25

### Fixed
- **Per-issue test mode now actually fires.** The 0.8.11-mil.0 feature was silently broken: Paperclip's heartbeat wake snapshot puts the issue title at `ctx.context.paperclipWake.issue.title` (not `ctx.context.taskTitle`) and **omits the issue body entirely**, so `resolveTestMode` always saw `body=""` and never matched the `<!-- mode: test -->` marker. Now `execute()` runs `enrichRunContext()` before resolving test mode: it reads the title from the wake snapshot if missing, and if the body is still empty it issues `GET /api/issues/<taskId>` to Paperclip (using the per-run JWT on `ctx.authToken`). Bounded 3-second timeout, non-fatal on failure. Diagnostic line `[hermes] enriched run context: taskTitle=wake-snapshot,taskBody=api (api=18ms)` lands in stdout on every successful enrichment.
- **`taskTitle=missing` log noise** — same root cause; title now resolves from the wake snapshot synchronously.

### Added
- 12 new tests in `run-context.test.ts` covering wake-snapshot title extraction, API-sourced body enrichment, marker-detection-via-API end-to-end, idempotence, `no_auth_token` / `http_404` / `timeout` failure modes, and URL normalization.

### Notes
- **No prompt-template change.** `mil-heartbeat-v3` already rendered `{{taskBody}}`; before this fix the variable was always empty.

## [0.8.11-mil.1] — 2026-04-25

### Changed
- **README ordering fix.** Re-sorted the "Currently in flight (0.8.x)" section so entries appear in ascending version order, matching how the package page reads top-to-bottom.

### Notes
- Docs-only release. No code changes from `0.8.11-mil.0`.

## [0.8.11-mil.0] — 2026-04-25

### Added
- **Per-issue test mode.** Operators can flip a *single* issue into test mode by including either an explicit machine-readable marker `<!-- mode: test -->` in the issue body, or a natural-language intent phrase (`smoketest`, `smoke test`, `smoke-test`, `test mode`, `low-cost validation`, `test flow`) anywhere in the title or body. The adapter probes each spawn's task title + body and routes that work tree to the free OpenRouter model. Closes the gap from 0.8.10's process-wide flag.
- **Sub-issue inheritance.** When the MCP `create_sub_issue` tool runs inside an adapter spawn that resolved to test mode, the adapter sets `PAPERCLIP_TEST_MODE=1` on the MCP subprocess env, and the tool prepends `<!-- mode: test -->` plus an `inherited from parent: …` provenance line to the sub-issue body. Idempotent: parents that already wrote the marker don't double-add.
- **Source-of-truth diagnostic banner.** The `*** TEST MODE ACTIVE ***` line ends with `source=<env|issue-marker|issue-intent> detail="<phrase or marker>"` so a single grep answers "where did this activation come from?".
- 24 new tests across `test-mode.test.ts`, `tools.test.ts`, and `hermes-home.test.ts`.

### Notes
- **Activation priority:** `PAPERCLIP_ADAPTER_TEST_MODE=1` env var > issue-marker > issue-intent > production.
- **What test mode still does NOT touch:** prompt template, per-agent role/skills, MCP tool allowlist, routine schedule. Only the LLM endpoint is swapped.
- **False-positive surface is deliberately conservative.** "Test" alone won't match — only the explicit phrases above.

## [0.8.10-mil.0] — 2026-04-25

### Added
- **Test-mode model override** via `PAPERCLIP_ADAPTER_TEST_MODE=1`. When the env var is truthy (`1`/`true`/`yes`/`on`), the adapter ignores every agent's configured `model` / `provider` / `auxiliaryModels` and routes ALL spawns to a free OpenRouter model for the lifetime of the process.
- Tunables: `PAPERCLIP_ADAPTER_TEST_MODEL` (default: `openrouter/free`), `PAPERCLIP_ADAPTER_TEST_PROVIDER` (default: `openrouter`), `PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL` (defaults to the same value).
- Loud `[hermes] *** TEST MODE ACTIVE *** agent=<name> model=X->Y provider=X->Y auxiliary=*->Y` banner emitted at the top of every spawn while active.
- 13 new unit tests in `test-mode.test.ts`.

### Notes
- **Off by default.** Existing deployments behave identically until the env var is set.
- Free-model availability fluctuates on OpenRouter. The `openrouter/free` meta-router default is resilient to specific models being deprecated.
- Auxiliary slots (`compression`, `vision`, `session_search`, `title_generation`) are all forced to the test model when the flag is on.

## [0.8.9-mil.0] — 2026-04-25

### Added
- **Per-agent auxiliary-models override** (`adapterConfig.auxiliaryModels`). Each top-level key is a Hermes auxiliary slot name (`compression`, `vision`, `session_search`, `title_generation`, …) and the value is an arbitrary YAML object passed through verbatim to the per-run `config.yaml` `auxiliary:` block. Lets operators preempt the cost regression in Hermes >= v2026.4.23 (v0.11.0), which changed the default for auxiliary tasks from "use a cheap aggregator-side model" to "use the main model".
- New diagnostic in `[hermes] per-run config.yaml env: …`: `auxiliary=<bool>` so a missed override is visible in one stdout line.
- Slot-level merge with `~/.hermes/config.yaml`: per-agent override wins on slot collisions; operator-global slots not named in adapterConfig survive untouched.
- 9 new tests in `hermes-home.test.ts`.

### Notes
- **No-op against the currently-pinned Hermes** (`v2026.4.13` / v0.9.0) — the `auxiliary:` block didn't exist there. Safe to roll out before bumping `HERMES_VERSION`.
- Backwards compatible: when `adapterConfig.auxiliaryModels` is absent / null / `{}`, the adapter writes no `auxiliary:` key at all.

## [0.8.8-mil.2] — 2026-04-04

### Changed
- **README scrubbed of consumer-specific operational details.** Rewrote previously-named role and incident references to describe the mechanism and recommended policy generically. Also reordered the "Currently in flight (0.8.x)" section so versions appear in chronological order.

### Notes
- Docs-only release. No code changes from `0.8.8-mil.1`.

## [0.8.8-mil.1] — 2026-04-23

### Fixed
- **README release notes for 0.8.7 and 0.8.8 were missing.** npmjs.com's Versions tab reads from the package README; the missing entries meant those features didn't show up alongside `0.8.4`/`0.8.5`/`0.8.6`. Added the entries.

### Notes
- Docs-only release. No code changes from `0.8.8-mil.0`.

## [0.8.8-mil.0] — 2026-04-22

### Added
- **Per-agent MCP tool allowlist.** `buildServer({allowedTools})` now filters `ALL_TOOLS` to a per-agent list. Propagated end-to-end via the `PAPERCLIP_MCP_TOOLS=<comma,separated>` env var on the per-run `config.yaml` (three states: unset → register all; `""` → deny-all; `"a,b,c"` → allowlist).
- Exported helpers `parseAllowedToolsEnv` and `resolveToolsToRegister` for unit tests.
- 11 new tests covering allowlist filtering, env-var round-trip, and unknown-name tolerance.

### Changed
- **`create_sub_issue` now REQUIRES `parentIssueId`.** Previously optional; empty/blank now returns `retryPolicy=fix-args` with `MISSING_PARENT` audit log. Combined with the existing `assertWriteScope`, agents can only create sub-tasks of the issue they're actively working on.

### Why
Companion to `0.8.7-mil.0`. 0.8.7 stops the LLM call on no-work heartbeat wakes; 0.8.8 closes the structural path that let agents create unparented top-level issues.

## [0.8.7-mil.0] — 2026-04-22

### Added
- **Adapter pre-flight check.** Before invoking Hermes, query `GET /companies/:id/issues?assigneeAgentId=:agent` and skip the spawn (returning `resultJson.preflight: "skipped"`) if zero open issues are assigned. Fail-open on any ambiguity.
- New `config.preflightSkip` per-agent opt-out.
- 8 new tests covering explicit-task bypass, fail-open paths, and skip decisions.

### Why
First half of a two-part fix (paired with `0.8.8-mil.0`). Stops the "wake → zero-work LLM call" pattern where idle agents on periodic heartbeat schedules each spent a full LLM call per wake just to discover there was nothing to do.

## [0.8.6-mil.0] — 2026-04-19

- Probe fails closed on missing `state.db` (A.1 follow-up).

## [0.8.5-mil.0] — 2026-04-19

- Pre-spawn session-existence probe in Hermes state DB (prevents resume-of-unknown-session crashes).

## [0.8.4-mil.0] — 2026-04-19

- `adapterVersion` included in `resultJson` for every run.
- New canonical `src/shared/version.ts` module; release workflow verifies it matches `package.json`.

## Older versions

For versions prior to 0.8.4, see the [GitHub Releases](https://github.com/marketintellabs/hermes-paperclip-adapter/releases) page or the git log.
