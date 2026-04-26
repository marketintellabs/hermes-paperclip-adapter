# Changelog

All notable changes to the `@marketintellabs/hermes-paperclip-adapter` fork are documented here. The canonical source of release notes is the [GitHub Releases page](https://github.com/marketintellabs/hermes-paperclip-adapter/releases), which is what npmjs.com surfaces on the package page.

This file is a condensed, human-readable summary. For full context (test coverage, upgrade steps, related incidents), follow the GitHub Release link for each version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/) with the `-mil.N` prerelease suffix marking MIL fork releases.

## [0.8.18-mil.0] — 2026-04-26

### Added
- **Retry-with-backoff on transient LLM failures.** `runChildProcess` is now wrapped in a retry loop driven by a conservative classifier (`src/server/retry-policy.ts`). When a finished run looks like an upstream blip — OpenRouter status 429 or 5xx, Anthropic `overloaded_error` / `rate_limit_error`, generic HTTP 502/503/504, `provider overloaded`, gateway timeouts, ECONNRESET, ETIMEDOUT — the adapter sleeps `retryBackoffSec` (default 30s), emits a `[hermes] retrying after transient failure …` notice, and respawns Hermes with the same args. Hard timeouts and SIGKILLs are explicitly classified as **permanent** (a run that already burned its full timeout budget either ran a tool loop or the model genuinely can't finish in time, and retrying just doubles wall clock without changing the outcome). Default budget is **one** retry; tunable via `retryMaxAttempts` (clamped to 3) and `retryBackoffSec` (clamped to 600). Disable with `retryOnTransient: false`. Each retry is recorded in `result_json.retries[]` plus a `retryAttempts` counter that's always present so dashboards can filter cleanly. The classifier requires *strong* markers (HTTP-status-shaped lines, provider-shaped error envelopes) — not just the word "rate" — to avoid infinite retry loops on permanent bugs.
- **`maxTranscriptEntries` config — opt-in cap on `ctx.onLog` chunks per run.** Above the cap, further LLM-output chunks are suppressed and a single `[hermes] transcript truncated: cap=N reached …` notice is emitted. Adapter-emitted `[hermes] *` lines (banner, exit code, MCP telemetry summary, soft-timeout warning, auto-repair alerts, retry notices) ALWAYS bypass the cap so structural diagnostics are never lost — the cap targets noisy LLM streaming, not adapter output. `result_json.transcriptObserved`, `transcriptSuppressed`, and `transcriptTruncated` make the cap's effect inspectable. Default `0` (unlimited) preserves pre-0.8.18 behaviour; recommended setting for agents that occasionally emit hundreds of streamed chunks per run is ~200.
- **Runtime health-check CLI: `paperclip-hermes-health`.** New bin entry runs four probes and prints structured JSON: hermes-binary on PATH (`hermes --version`), `$HERMES_HOME` exists + writable (real `mkdtemp` test — needed because some EFS configurations lie on `access(W_OK)`), `state.db` opens cleanly via `node:sqlite` and reports session count, OpenRouter reachability via an unauthenticated `GET /api/v1/models` with a 5s `AbortSignal.timeout`. Exit codes: `0` pass, `1` fail (foundational), `2` warn (non-foundational, e.g. OpenRouter degraded). Flags: `--no-network`, `--pretty`, `--hermes-home`, `--hermes-cmd`. Designed for two callers: (a) a human shell-execing during incident triage, (b) the Staff Engineer agent calling it via shell and parsing JSON instead of running ad-hoc diagnostic commands. Check codes (`hermes_binary`, `hermes_home_ok`, `state_db_ok`, `openrouter_ok`, etc.) are stable across patch releases.
- **30 new unit tests** across `retry-policy.test.ts` (10 — classifier coverage, config clamping, notice formatting), `transcript-cap.test.ts` (6 — passthrough/cap/diagnostic-bypass), `env-unwrap.test.ts` (8 — wrapper unwrap + `[object Object]` regression guard), `health-check.test.ts` (6 — pass/fail/warn matrix). Total adapter test count: 328 → 358.

### Fixed
- **Env-var unwrap regression — cherry-picked from upstream NousResearch PR #29.** Pre-0.8.18 `Object.assign(env, userEnv)` copied Paperclip's `{ type, value }` secret-ref wrappers verbatim, so spawned Hermes saw `ANTHROPIC_API_KEY=[object Object]` for any key set via `adapterConfig.env`. The bug was latent in our deploy because every key that matters is set via the ECS task-definition env (container-level), not through Paperclip's per-agent secret refs — but the next operator who reached for the "Secrets" tab would have hit it. Replaced with `unwrapUserEnv` (`src/server/env-unwrap.ts`) that handles plain strings, `{ value }` wrappers (with or without `type`), and tracks anything weird in a `droppedKeys` array surfaced as a single `[hermes] WARN: dropped N adapterConfig.env entries …` line per run. Credit @lucasproko for the original report; PR #29 has been open since 2026-03 and never merged.

### Notes
- **Audit of upstream PRs #28 and #31 — explicitly NOT cherry-picked.** PR #28 ("Improve Hermes thinking/tool states") defaults Hermes to non-quiet mode, which conflicts with our 0.8.x `-Q` strategy and our `parseHermesOutput` contract that depends on the quiet-mode session-ID line shape — porting it requires redoing `parse-hermes-output.ts`. PR #31 ("comprehensive adapter parity", 1,400 lines) overlaps heavily with what 0.8.x already ships differently — state.db cost extraction via heartbeat-v3 result_json, smart stderr filtering via auto-repair detector + benign-stderr reclassifier; the remaining novel pieces (profile-aware skill injection, billing-type "subscription" detection) aren't load-bearing for our ECS deployment. Both audited and skipped — divergence cost is real and not worth the bug surface for a marginal gain on features we already provide.
- **Wire-format additions are all additive.** `result_json` gains `retries`, `retryAttempts`, and (when the cap is set) `transcriptCap` / `transcriptObserved` / `transcriptSuppressed` / `transcriptTruncated`. Downstream consumers that ignore unknown keys keep working unchanged.
- **`paperclip-hermes-health` and the env-unwrap fix are zero-config wins.** The retry policy is on by default with conservative settings (1 retry, 30s backoff) — operators can opt out per agent by setting `retryOnTransient: false`. The transcript cap is opt-in (default `0` = no cap) so existing UIs keep their full-fidelity transcripts unless an operator explicitly wants to clamp a noisy agent.
- **`ADAPTER_VERSION` in `src/shared/version.ts` was stale at `0.8.16-mil.0` for two releases (0.8.16-mil.1 and 0.8.17-mil.0). Bumped to 0.8.18-mil.0 in this release.** `result_json.adapterVersion` will now correctly report 0.8.18 on every run; previous releases under-reported themselves as 0.8.16.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.18-mil.0)

## [0.8.17-mil.0] — 2026-04-26

### Added
- **Auto-repair detector — surfaces Hermes' silent fuzzy tool-name rewrites as loud stderr alarms.** Hermes Agent's Python tool-call parser (`/opt/hermes-agent/run_agent.py`) runs a fuzzy match on every emitted `<TOOLCALL>{...}</TOOLCALL>` block: if the LLM names a tool that doesn't exist exactly in the agent's registry — typo, stale name, or a brand-new tool the worker isn't authorised for — Hermes silently rewrites the call to the closest-matching registered tool, prints a single `🔧 Auto-repaired tool name: 'X' -> 'Y'` line, and dispatches the rewritten call. We've observed this in production: a non-delegator worker calling `mcp_paperclip_create_sub_issues` (a tool only delegators have on their allowlist) was silently mapped to `mcp_paperclip_get_issue` — the call "succeeded", returned garbage from the worker's POV, and the actual decomposition the LLM intended never happened. No alarm, no failed run, no telemetry — pure silent breakage. The new detector watches the Hermes stdout/stderr stream for the `🔧 Auto-repaired tool name:` signature, extracts the original→repaired tool names, and (1) emits a `[hermes] ERROR: auto-repair: Hermes silently rewrote 'X' → 'Y'; …` line on **stderr** at the moment of detection (so Paperclip's UI renders it in the red error track instead of blending into stdout), and (2) when the agent has a `paperclipMcpTools` allowlist, classifies whether the *original* (pre-repair) tool name was authorised for this agent — the alert message says either "ORIGINAL tool was NOT in the per-agent allowlist" (the high-signal failure case) or "original tool IS in the per-agent allowlist (likely typo or near-miss)" (the benign case). Every detection is also recorded in `result_json.autoRepairs[]` (with `original`, `repaired`, `unauthorized`, `ts`) plus the rollup counters `result_json.autoRepairCount` and `result_json.autoRepairUnauthorizedCount`, so dashboards and postmortems can find these structurally without parsing log streams. Disable via `adapterConfig.autoRepairAlerts = false`. The detector does NOT abort the run — Hermes' auto-repair sometimes saves a benign typo (e.g. `list_my_issue` → `list_my_issues`) and we don't want to nuke working agents over it. Loud + observable is the contract; the operator decides policy from the structured record.
- **12 new unit tests** in `auto-repair-detector.test.ts`: benign-chunk steady state, original/repaired extraction, multi-line chunk handling, CRLF tolerance, unauthorized-vs-near-miss classification, both bare and namespaced (`mcp_paperclip_…`) allowlist forms, opt-out flag, message wording differentiation across all three classification states, and a false-positive guard so a tool result line containing `🔧` in arbitrary text doesn't trigger.

### Notes
- **No wire-format or prompt-template change.** Pure observability addition — wires into the existing `ctx.onLog("stderr", …)` path that already feeds Paperclip's red error track and CloudWatch. Safe rolling deploy. The new `result_json.autoRepairs[]` field is additive and downstream consumers that ignore unknown keys keep working unchanged.
- **Why this lives in the adapter, not in Hermes.** Hermes' fuzzy matcher runs in the Python tool-call dispatcher *before* the call ever reaches the adapter's MCP server, so by the time the call lands at the adapter the tool name has already been rewritten and the original intent is gone. The adapter cannot intercept the rewrite, but it CAN tee Hermes' announcement of the rewrite into a structured signal — which is what this module does. A future patch to Hermes itself (gating fuzzy match against the per-agent tool registry) would obviate this, but until then the adapter is the right shim.
- **The unauthorized-vs-near-miss split is the operator's primary triage signal.** A near-miss (`list_my_issue` → `list_my_issues`) is an LLM typo and usually self-heals; the loud alert is mainly for visibility. An unauthorized rewrite (`create_sub_issues` → `get_issue`) means the agent's allowlist was the only thing standing between the LLM and a wrong-shape call — investigate the prompt template (does it advertise tools the agent doesn't have?) and the agent's adapterConfig (was a recent allowlist edit incomplete?). Both should be rare; both should be loud when they happen.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.17-mil.0)

## [0.8.16-mil.1] — 2026-04-26

### Changed
- **README ordering fix.** The "Currently in flight (0.8.x)" section in the README listed `0.8.16` before `0.8.15` before `0.8.14` — out-of-order tail caused by appending `0.8.14`/`0.8.15`/`0.8.16` entries at the wrong end of the section. Re-sorted so every entry now appears in ascending version order — `0.8.0 → 0.8.1 → … → 0.8.14 → 0.8.15 → 0.8.16` — matching how the section was originally laid out and how npmjs.com renders the package page top-to-bottom. Same shape of regression we shipped patches for in `0.8.8-mil.2` and `0.8.11-mil.1`; this release adds a CI-enforceable guard so it stops happening.

### Added
- **`src/shared/readme-order.test.ts` — automated guard against the recurring out-of-order regression.** Two tests run on every CI build: (1) parses every `**X.Y.Z-mil.N — ` header in `README.md` and asserts the (X, Y, Z, N) tuples are monotonically non-decreasing, with a failure message that names the offending lines AND prints the expected order so the operator can fix it without re-reading the whole file; (2) cross-checks `package.json.version` against the latest README header to catch the case where someone bumps the package but forgets to add the README entry entirely (which would leave npm's package page silently stale at the previous version's notes). Both tests fail loud with actionable error messages explaining why the README and CHANGELOG use opposite orderings (CHANGELOG is reverse-chronological per Keep-a-Changelog convention; README is ascending because npmjs.com renders top-to-bottom).

### Notes
- Docs-only release. No code changes from `0.8.16-mil.0`. Existing deployments do not need to redeploy.
- Republished to npm so the package page on npmjs.com picks up the corrected README. (npm only re-renders the README on a fresh publish — version bumps + dist-tag changes alone don't refresh it.)

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.16-mil.1)

## [0.8.16-mil.0] — 2026-04-26

### Added
- **`create_sub_issues` (plural) MCP tool — bulk parallel delegation.** Existing `create_sub_issue` is preserved unchanged for one-off delegations; the new plural form takes one shared `parentIssueId` plus an array of `subIssues` (capped at 10 per call) and POSTs them via `Promise.allSettled`. Three concrete wins for delegators (CEO, Heads): (1) **One MCP-call-budget unit, N children** — a CEO decomposing one investigation into 5 research streams used to burn 5 of the 20 `MAX_TOOL_CALLS` slots; the bulk path collapses that to 1 slot, leaving budget for follow-up comments and status updates without raising the cap. (2) **Wall-clock saving** — 5 sequential POSTs against Paperclip (network RTT + per-issue work) typically cost 10–15 s; parallel `Promise.allSettled` brings that to one RTT bounded by the slowest child. (3) **Partial-failure semantics** — one transient 503 on child #3 cannot sink children #1, #2, #4, #5; the LLM gets a per-item outcome array with per-index `retryPolicy` and can retry only the failed indices. Aggregate retry policy is escalated to `fix-args` if ANY child saw a 4xx in an all-failure case, so the LLM stops looping on a malformed payload. Test-mode marker inheritance is applied per child (idempotent — already-marked descriptions aren't re-prepended); a single rollup `create_sub_issues test_mode_inherit` audit-log event keeps grep parity with the singular tool. The wire-shape contract — `parentId` (NOT `parentIssueId`), explicit `status: "todo"` so each child fires `on_assign` — lives in one shared `buildPayload` helper to defend the MAR-204/206/207 (2026-04-25) regression on every child of every batch.
- **Updated prompt template `builtin:mil-heartbeat-v3`** to advertise both tools with explicit guidance: "Use `create_sub_issues` when delegating 2+ items at once — saves tool-call budget and runs in parallel." Minor copy update only; no template variable changes.
- **11 new unit tests** in `create-sub-issues.test.ts`: happy path with N children + wire-shape contract per child, partial failure with per-index retry policy, all-failure aggregate policy escalation when any child is 4xx, missing parentIssueId, missing companyId, scope-violation rejection (no POSTs), runtime over-cap defense, test-mode marker prepend / idempotency / `_SOURCE_DETAIL` precedence.

### Fixed
- **`npm test` now actually runs all test files.** The previous test script `node --test dist/**/*.test.js` relied on `**` globstar which is NOT enabled by default in `sh` (which `npm run-script` uses). The pattern silently expanded to match only `dist/X/Y.test.js` and skipped every test file three levels deep, including `dist/mcp/tools/tools.test.js` (43 tests covering the singular `create_sub_issue` and other MCP tools). Quoting the glob (`'dist/**/*.test.js'`) hands the pattern to `node --test`'s native glob expansion, which DOES recurse. Test count jumped from 224 → 278 with no other code changes — those 54 tests had been passing locally but never running in CI on previous releases. No coverage was actually broken (the tests pass), but the regression-protection invariant was. Worth a callout because every previous "tests pass" claim in `0.8.x-mil.N` was technically incomplete.

### Notes
- **No wire-format or run-behaviour change.** The plural tool is purely additive — singular `create_sub_issue` is untouched. Allowlist gate (`paperclipMcpTools`) is the same `can_delegate` policy: agents that already have `create_sub_issue` need to be reconciled to also include `create_sub_issues`, otherwise the LLM sees "tool not registered" on bulk calls and falls back to N singular calls automatically. Companion `marketintellabs#NN` updates `paperclip/configure-agents.mjs` and `paperclip/apply-mcp-tools.mjs` to grant both tools to delegators.
- **One MCP-call-budget unit per batch** is enforced inside the MCP server — `callCount` increments once per `tool_call_start` regardless of fan-out width. The 20-call cap stays exactly where it was; agents just stretch farther.
- **`Promise.allSettled`, not `Promise.all`** is the deliberate choice. A 503 on child #3 of 5 is the kind of transient we see during heavy fan-out windows; `Promise.all` would surface that as a single tool failure and force the LLM to retry the whole batch (or worse, manually replay each child). The settled outcome array preserves the per-child retry decision in the LLM's hands.
- **The `npm test` glob fix is technically a bug fix for a workflow-level regression.** Worth a fresh release tag rather than rolling into 0.8.15 because the tag is what triggers npm publish + GitHub Release; CI on the merged adapter PR #17 was reporting 224/224 pass when 278 should have run. No production behaviour was affected (tests are dev-only), but the truth-in-CI delta is nontrivial.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.16-mil.0)

## [0.8.15-mil.0] — 2026-04-26

### Added
- **Skill preload validation at run start.** `execute()` now stat()s every path declared in `adapterConfig.hermes_skill` and `adapterConfig.hermes_skills` against the resolved skills root (`HERMES_SKILLS_DIR`, falling back to `/data/hermes/skills`). Each declared-but-missing skill produces a `[hermes] WARN: skill "<ref>" declared in adapterConfig … but not found at <abspath> — Hermes will run WITHOUT this skill` line on stderr, and a single rollup `[hermes] skills validated: N/M present, K MISSING` line on stdout. Hermes itself silently ignores missing skill files at run time, so an agent referencing `skills/persona-sarah-chen.md` after the file was renamed or unmounted from EFS used to run without the persona and the operator only noticed because the output sounded wrong. The validator is purely diagnostic — never fatal — and is wired in BEFORE pre-flight so the warning lands even on no-op wakes that exit without spawning Hermes.
- **Soft-timeout warning at 80% of `timeoutSec`.** `execute()` schedules a one-shot `setTimeout` after the child process spawns. When fired, it emits `[hermes] WARN: soft-timeout reached at <N>s (80% of <T>s hard limit). Run still in progress; consider raising adapterConfig.timeoutSec if this becomes routine.` to stderr. Skipped entirely if `timeoutSec ≤ 0`, if the warning would fire below a 5-second floor, or if the operator opts out via `adapterConfig.softTimeoutWarn=false`. Threshold tunable via `adapterConfig.softTimeoutThreshold` (any value strictly between 0 and 1; defaults to 0.8). The timer is unref()d so it doesn't keep the event loop alive past the run, and it's cleared in the same `finally` block that runs MCP telemetry collection — no leak path even if the run throws synchronously. Operationally this surfaces "agents that consistently brush their hard timeout" before one of them actually trips it, giving operators a chance to right-size `timeoutSec` per agent without needing a failure to investigate.
- 14 new unit tests across `validate-skills.test.ts` (config shape edge cases, env-var resolution, absolute-path passthrough, fault tolerance) and `soft-timeout.test.ts` (default threshold, opt-out, custom threshold clamping, message formatting).

### Notes
- **No wire-format or prompt-template change.** Both additions are observability-only: they emit log lines into the existing `ctx.onLog("stdout"|"stderr", …)` stream that already feeds the Paperclip run transcript and CloudWatch. Safe rolling deploy — no config migration required, every flag is opt-in to the existing default behavior.
- **`soft-timeout` interaction with the hard timeout is none.** The hard timeout in `runChildProcess` (`timeoutSec` + `graceSec`) still owns SIGTERM / SIGKILL of a hung child; the soft warning is purely informational and does not modify run behaviour.
- **Skill validation is best-effort I/O.** A flaky EFS mount won't break a run — every `fs.stat` failure is caught individually and counted toward `missing` so the WARN line still appears, and a higher-level catch around the whole validator emits a single `[hermes] skill validation failed (non-fatal): …` line if something more catastrophic goes wrong. Disable by clearing `hermes_skill` / `hermes_skills` from `adapterConfig` (no-op when both are empty).
- **Companion to the Hermes Agent v2026.4.23 (v0.11.0) bump.** Both items in this release surface state that becomes more important after the Hermes upgrade: the new `agent.api_max_retries` config (Hermes #14730) and activity-heartbeats (Hermes #10501) handle transient LLM failures and gateway-restart resume more gracefully, so persistent timeouts are now more meaningful as a "this agent is genuinely stuck" signal — exactly what soft-timeout warnings are designed to surface early.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.15-mil.0)

## [0.8.14-mil.0] — 2026-04-25

### Added
- **`resultJson.modelUsed` / `provider` / `providerSource` are now populated on every successful run.** Dashboards and post-run telemetry queries can now answer "which model did this agent run on?" directly from `heartbeat_runs.result_json` instead of grepping `stderr_excerpt` for the `[hermes] Starting Hermes Agent (model=…)` banner. Values come from the adapter's own model/provider resolver — the same source the banner uses — so they are authoritative even when Hermes' stdout is quiet (which is most successful runs). `providerSource` is `hermesConfig` for the configured route or `test-mode-override` when per-run test mode is winning.
- **`resultJson.result_marker_present` (canonical name) for the agent's `RESULT:` marker.** This field is set to `true` when the agent's final message contained a `RESULT: done|blocked|cancelled` marker (the v2+ adapter-owned-status contract), `false` when the marker was missing and the run defaulted to `done` with no explicit terminal-status signal from the LLM. The `result_marker_present` name is unambiguous about which marker is being checked.

### Changed
- **`resultJson.marker_present` is now a deprecated alias of `result_marker_present`.** The old name was misleading because operators reasonably read it as "test-mode marker present" (`<!-- mode: test -->`), which is a completely different concept. The deprecated alias is preserved for one release so existing dashboards / SQL queries continue to work; both fields will hold the same boolean. The alias will be removed in `0.9.0` — migrate to `result_marker_present` now.

### Notes
- **`resultJson.cost_usd` remains `null` for successful runs against Hermes Agent v0.9.0 (`v2026.4.13`).** This is not a regression and not a bug in 0.8.14 — the upstream Hermes Agent does not emit a cost or token-usage line in stdout/stderr in quiet mode, so `parseHermesOutput`'s `COST_REGEX` / `TOKEN_USAGE_REGEX` never match. The OpenRouter web dashboard remains the source of truth for spend. A future adapter release will call OpenRouter's `GET /api/v1/generation` endpoint after the run completes to backfill `cost_usd` / `usage`; the work is tracked in `marketintellabs/docs/ADAPTER_LIFECYCLE.md` as an open follow-up.
- **No prompt-template change.** This is a `result_json` shape change only. Agents and MCP tools are unaffected. Safe rolling deploy.
- **Postmortem reference:** Stage 3 retest (paid-model end-to-end) entry in `marketintellabs/docs/ADAPTER_LIFECYCLE.md` flagged both the `null` cost on successful runs and the misnamed `marker_present` field; this release closes the second item and documents the root cause of the first.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.14-mil.0)

## [0.8.13-mil.0] — 2026-04-25

### Fixed
- **`create_sub_issue` no longer creates orphaned children.** The adapter sent `parentIssueId` in the POST body; Paperclip's `POST /companies/:id/issues` schema uses the column-aligned name `parentId` and silently drops unknown fields, so every sub-issue landed with `parent_id = NULL`. The parent never saw its children, status reconciliation didn't propagate, and the test-mode-inheritance fix from 0.8.11-mil.0 (which prepends `<!-- mode: test -->` to the child body) couldn't help because the child was never linked to the parent in the first place. Now the payload uses `parentId`, and a regression test asserts the wire shape so the field name can't drift again.
- **Delegated sub-issues now wake the assignee immediately.** The same `POST` was missing a `status` field, so Paperclip defaulted it to `backlog`. `backlog` does not fire the assignee's `on_assign` heartbeat, so the delegated agent never woke up — the work just sat there. The adapter now explicitly sends `status: "todo"`. Combined with the `parentId` fix, delegation actually delegates: the parent calls `create_sub_issue`, Paperclip writes a `todo` issue with the right `parent_id`, the assignee wakes within seconds, and the parent's status reconciliation closes the loop on completion.

### Added
- One regression test (`payload contract: parentId + status=todo even when test mode + priority unset`) and four new assertions on the existing happy-path test, all locking the wire-level field names that Paperclip actually accepts. The previous happy-path test was the reason this regression shipped — it asserted `body.parentIssueId === ...`, which was the field the adapter *sent* but not the field Paperclip *read*. Now the test fixtures the actual API contract: `body.parentId` is set, `body.parentIssueId` is `undefined`, `body.status === "todo"`.

### Notes
- **Postmortem:** see Stage 3 entry in `marketintellabs/docs/ADAPTER_LIFECYCLE.md` (2026-04-25). Surfaced during paid-model retest after Stage 2 validated test-mode activation. Ironically caught by switching to a paid model — the free model's tool-call failures were masking this bug because no `create_sub_issue` call ever succeeded in the free-model runs.
- **No prompt-template change.** This is a wire-format fix in the MCP tool layer; the LLM-facing tool input schema still uses `parentIssueId` (descriptive — pairs with `assigneeAgentId`, `companyId`).

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.13-mil.0)

## [0.8.12-mil.1] — 2026-04-25

### Changed
- **README updated to include the 0.8.12 entry.** The 0.8.12-mil.0 tarball shipped without a "Currently in flight" entry for itself in the README, so the npmjs.com package page still listed 0.8.11-mil.0 as the most recent feature even though the version selector showed 0.8.12-mil.0 at the top. Added the entry; republished so npm re-renders the README. (npm only re-renders the package page README on a fresh publish — version + dist-tag changes alone don't refresh it.)

### Notes
- Docs-only release. No code changes from `0.8.12-mil.0`. Existing deployments do not need to redeploy.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.12-mil.1)

## [0.8.12-mil.0] — 2026-04-25

### Fixed
- **Per-issue test mode now actually fires.** The 0.8.11-mil.0 feature was silently broken in production: Paperclip's heartbeat wake snapshot puts the issue title at `ctx.context.paperclipWake.issue.title` (not on `ctx.context.taskTitle`) and **omits the issue body entirely**, so the adapter's `resolveTestMode` always saw `body=""` and never matched the `<!-- mode: test -->` marker. Every per-issue smoketest silently downgraded to the production paid model. Now `execute()` runs `enrichRunContext()` before resolving test mode: it reads the title from the wake snapshot if missing, and if the body is still empty it issues `GET /api/issues/<taskId>` to Paperclip (using the per-run JWT already on `ctx.authToken`) to fetch the description. Bounded 3-second timeout, non-fatal on failure — the run continues exactly as it would have on 0.8.11 if the API call fails. Diagnostic line `[hermes] enriched run context: taskTitle=wake-snapshot,taskBody=api (api=18ms)` lands in stdout on every successful enrichment.
- **`taskTitle=missing` log noise.** Same root cause: the canonical resolver was looking at the wrong place. Title now resolves from the wake snapshot synchronously (no I/O) so `[hermes] run context provenance: ...` no longer reports `taskTitle=missing` for normal Paperclip wakes.

### Added
- 12 new tests in `run-context.test.ts` covering wake-snapshot title extraction, API-sourced body enrichment, marker-detection-via-API end-to-end, idempotence (no fetch when body already populated), `no_auth_token` / `http_404` / `timeout` failure modes, and trailing-slash / missing-`/api` URL normalization.

### Notes
- **No prompt-template change.** `mil-heartbeat-v3` already rendered `{{taskBody}}`; before this fix the variable was always empty. With enrichment it now expands to the actual issue body, which means agents have the body in their first prompt instead of having to call `mcp_paperclip_get_issue` to fetch it. One fewer round-trip per wake; net token cost is roughly neutral (issue body was going into context either way).
- **Postmortem:** see the 2026-04-25 Stage 2 entry in `marketintellabs/docs/ADAPTER_LIFECYCLE.md` for the full investigation.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.12-mil.0)

## [0.8.11-mil.1] — 2026-04-25

### Changed
- **README ordering fix.** The "Currently in flight (0.8.x)" section in the README listed `0.8.9` / `0.8.10` / `0.8.11` in reverse-chronological order, breaking the chronological flow established by entries `0.8.0` through `0.8.8` above them. Re-sorted so every entry now appears in ascending version order — `0.8.0 → 0.8.1 → … → 0.8.10 → 0.8.11` — matching how the section was originally laid out and how the npmjs.com package page reads top-to-bottom. Pure docs change; the GitHub Releases page, which is reverse-chronological by date, was already correct.

### Notes
- Docs-only release. No code changes from `0.8.11-mil.0`. Existing deployments do not need to redeploy.
- Republished to npm so the package page on npmjs.com picks up the corrected README. (npm only re-renders the README on new version publish.)

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.11-mil.1)

## [0.8.11-mil.0] — 2026-04-25

### Added
- **Per-issue test mode** (CEO-facing UX). Operators (or the CEO agent) can now flip a *single* issue into test mode by including either an explicit machine-readable marker `<!-- mode: test -->` in the issue body, or a natural-language intent phrase (`smoketest`, `smoke test`, `smoke-test`, `test mode`, `low-cost validation`, `test flow`) anywhere in the title or body. The adapter probes each spawn's task title + body and routes that one work tree to the free OpenRouter model — production work on other issues is unaffected. Closes the gap from 0.8.10's process-wide flag, which required a redeploy to flip on/off.
- **Sub-issue inheritance.** When the MCP `create_sub_issue` tool runs inside an adapter spawn that resolved to test mode, the adapter sets `PAPERCLIP_TEST_MODE=1` on the MCP subprocess env, and the tool prepends `<!-- mode: test -->` plus an `inherited from parent: …` provenance line to the sub-issue body before posting to Paperclip. The woken sub-agent then probes its own assigned issue and inherits test mode automatically — no cross-process channel beyond the issue text the operator can see in the Paperclip UI. Idempotent: parents that already wrote the marker into their description don't double-add.
- **Source-of-truth diagnostic banner.** The `*** TEST MODE ACTIVE ***` line now ends with `source=<env|issue-marker|issue-intent> detail="<phrase or marker>"` so a single grep on production logs answers "where did this test-mode activation come from?" — operator big-hammer, CEO's smoketest issue, or inherited from a parent run.
- 24 new tests across `test-mode.test.ts`, `tools.test.ts`, and `hermes-home.test.ts` covering: marker detection (whitespace + case variants), intent phrase matching, false-positive guards (don't match "test the hypothesis" / "QA test" / "backtest"), env-vs-issue precedence, MCP env-var emission, sub-issue marker prepending, and idempotency.

### Notes
- **Activation priority:** `PAPERCLIP_ADAPTER_TEST_MODE=1` env var (operator big-hammer, process-wide) > issue-marker > issue-intent > production. Env wins because it's the incident-response lever; per-issue activation is the day-to-day UX.
- **What test mode still does NOT touch:** prompt template, per-agent role/department/skills, per-agent MCP tool allowlist, routine schedule. Same overrides as 0.8.10 — only the LLM endpoint is swapped.
- **Recommended CEO prompt snippet:** "Run a smoketest of the system in low-cost validation mode. Validate pipeline integrity end-to-end (wake-on-assign, MCP tool calls, status reconciliation, sub-agent delegation). Don't worry about output quality — free models are inconsistent under tool-use load." Either phrase ("smoketest" or "low-cost validation") trips the override; sub-agents inherit automatically.
- **False-positive surface is deliberately conservative.** "Test" alone won't match — only the explicit phrases above. Add carefully if you extend; each addition raises the chance of flipping a real production issue to free models because of unrelated copy.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.11-mil.0)

## [0.8.10-mil.0] — 2026-04-25

### Added
- **Test-mode model override** via `PAPERCLIP_ADAPTER_TEST_MODE=1`. When the env var is truthy (`1`/`true`/`yes`/`on`), the adapter ignores every agent's configured `model` / `provider` / `auxiliaryModels` and routes ALL spawns to a free OpenRouter model for the lifetime of the process. Lets operators run a full smoke test (routines firing, agents waking, MCP tool calls, status reconciliation) against the real production company without burning paid OpenRouter credits.
- Tunables (all optional):
  - `PAPERCLIP_ADAPTER_TEST_MODEL` — override model slug (default: `openrouter/free`, the OpenRouter meta-router that auto-picks a free tool-calling model).
  - `PAPERCLIP_ADAPTER_TEST_PROVIDER` — override provider (default: `openrouter`).
  - `PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL` — override the auxiliary-slot model independently of the main model (defaults to the same value).
- Loud `[hermes] *** TEST MODE ACTIVE *** agent=<name> model=X->Y provider=X->Y auxiliary=*->Y` banner emitted at the top of every spawn while active, so a single grep confirms the override fired and shows the original config that was overridden.
- 13 new unit tests in `test-mode.test.ts` covering truthiness parsing, default + explicit overrides, whitespace trimming, rawEnv snapshot, banner formatting, and inactive-mode safety.

### Notes
- **What test mode does NOT touch:** prompt template (still `builtin:mil-heartbeat-v3`), per-agent role/department/skills, per-agent MCP tool allowlist (`paperclipMcpTools`), routine schedule, Paperclip company configuration. Everything except the LLM endpoint is unchanged.
- **Off by default.** Existing deployments behave identically until the env var is set on the hermes ECS task definitions.
- Free-model availability fluctuates on OpenRouter. The `openrouter/free` meta-router default is resilient to specific models being deprecated; for pinned tests use a specific slug like `google/gemma-4-31b-it:free` or `openai/gpt-oss-120b:free`.
- Auxiliary slots (`compression`, `vision`, `session_search`, `title_generation`) are all forced to the test model when the flag is on, so test mode is truly $0/run regardless of how Hermes' default-fallback chain behaves.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.10-mil.0)

## [0.8.9-mil.0] — 2026-04-25

### Added
- **Per-agent auxiliary-models override** (`adapterConfig.auxiliaryModels`). Each top-level key is a Hermes auxiliary slot name (`compression`, `vision`, `session_search`, `title_generation`, …) and the value is an arbitrary YAML object passed through verbatim to the per-run `config.yaml` `auxiliary:` block. Lets operators preempt the cost regression introduced by Hermes >= v2026.4.23 (v0.11.0), which changed the default for auxiliary tasks from "use a cheap aggregator-side model" to "use the main model" — silently expensive for OpenRouter / Nous Portal users running an expensive main model like Claude Opus or grok-4.
- New diagnostic in the `[hermes] per-run config.yaml env: …` log line: `auxiliary=<bool>` so a missed override is visible in a single line of `stdout_excerpt` rather than buried in cost reports.
- Slot-level merge with `~/.hermes/config.yaml`: per-agent override wins on slot collisions; operator-global slots not named in adapterConfig survive untouched. So an operator can set `auxiliary.vision` globally while the adapter sets `auxiliary.compression` per-agent, and both end up in the per-run config.
- 9 new tests in `hermes-home.test.ts` covering the no-override / override / slot-collision / partial-merge / defensive-shape paths.

### Notes
- **No-op against the currently-pinned Hermes** (`v2026.4.13` / v0.9.0) — the `auxiliary:` block didn't exist there, Hermes ignores it. Safe to roll out per-agent before bumping `HERMES_VERSION` in the consumer's Dockerfiles.
- Backwards compatible: when `adapterConfig.auxiliaryModels` is absent / null / `{}`, the adapter writes no `auxiliary:` key at all (preserves the pre-0.8.9 behaviour exactly).
- See the README "MIL-specific features" entry for the recommended OpenRouter cheap-default config snippet.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.9-mil.0)

## [0.8.8-mil.2] — 2026-04-04

### Changed
- **README scrubbed of consumer-specific operational details.** The `0.8.8-mil.0` release notes previously named specific agent roles (CEO, Chief of Staff, Heads, Managing Editor, etc.) and referenced an internal incident (the "49-issue fabrication spree"). Rewrote those passages to describe the mechanism and recommended policy generically, so the public npmjs.com package page doesn't leak consumer org structure. Also reordered the "Currently in flight (0.8.x)" section so versions appear in chronological order (0.8.0 → 0.8.8) instead of having 0.8.2 appended at the bottom out of sequence.

### Notes
- Docs-only release. No code changes from `0.8.8-mil.1`. Existing deployments do not need to redeploy.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.8-mil.2)

## [0.8.8-mil.1] — 2026-04-23

### Fixed
- **README release notes for 0.8.7 and 0.8.8 were missing**, which is what npmjs.com's Versions tab reads from (npm renders the package README on both the main tab and the versions tab; it does NOT pull from git tags or GitHub Releases). Added the "Currently in flight (0.8.x)" entries for `0.8.7-mil.0` (pre-flight skip) and `0.8.8-mil.0` (per-agent tool allowlist + required `parentIssueId`) so they show up alongside `0.8.4`/`0.8.5`/`0.8.6` on npmjs.com.

### Notes
- Docs-only release. No code changes from `0.8.8-mil.0`; adapter behaviour, MCP tool surface, and pre-flight semantics are identical. Existing deployments do not need to redeploy unless you specifically want the updated README shipped inside the published tarball.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.8-mil.1)

## [0.8.8-mil.0] — 2026-04-22

### Added
- **Per-agent MCP tool allowlist.** `buildServer({allowedTools})` now filters `ALL_TOOLS` to a per-agent list. Propagated end-to-end via the `PAPERCLIP_MCP_TOOLS=<comma,separated>` env var on the per-run `config.yaml` (three states: unset → register all; `""` → deny-all; `"a,b,c"` → allowlist).
- Exported helpers `parseAllowedToolsEnv` and `resolveToolsToRegister` for unit tests.
- 11 new tests covering allowlist filtering, env-var round-trip (unset/empty/list), and unknown-name tolerance.

### Changed
- **`create_sub_issue` now REQUIRES `parentIssueId`.** Previously optional; empty/blank now returns `retryPolicy=fix-args` with `MISSING_PARENT` audit log. Combined with the existing `assertWriteScope`, agents can only create sub-tasks of the issue they're actively working on — top-level issues come only from humans or Paperclip Routines.

### Why
Companion to `0.8.7-mil.0`. 0.8.7 stops the LLM call on no-work heartbeat wakes; 0.8.8 closes the structural path that let agents fabricate unparented top-level issues when they did run. Together they address the two failure modes behind the autonomous-work-loop class of cost incident.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.8-mil.0)

## [0.8.7-mil.0] — 2026-04-22

### Added
- **Adapter pre-flight check.** Before invoking Hermes, query `GET /companies/:id/issues?assigneeAgentId=:agent` and skip the spawn (returning `resultJson.preflight: "skipped"`) if zero open issues are assigned. Fail-open on any ambiguity — the pre-flight is an optimization, not a correctness barrier.
- New `config.preflightSkip` per-agent opt-out.
- 8 new tests covering explicit-task bypass, fail-open paths, and skip decisions.

### Why
First half of a two-part autonomous-work-loop fix (paired with `0.8.8-mil.0`). Stops the "wake → zero-work LLM call → credits burned" pattern where idle agents on periodic heartbeat schedules each spent a full LLM call per wake just to discover there was nothing to do.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.7-mil.0)

## [0.8.6-mil.0] — 2026-04-19

- Probe fails closed on missing `state.db` (A.1 follow-up).

## [0.8.5-mil.0] — 2026-04-19

- Pre-spawn session-existence probe in Hermes state DB (prevents resume-of-unknown-session crashes).

## [0.8.4-mil.0] — 2026-04-19

- `adapterVersion` included in `resultJson` for every run.
- New canonical `src/shared/version.ts` module; release workflow verifies it matches `package.json`.

## Older versions

For versions prior to 0.8.4, see the [GitHub Releases](https://github.com/marketintellabs/hermes-paperclip-adapter/releases) page or the git log. Historical entries are preserved in commit messages but not backfilled here.
