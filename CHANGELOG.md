# Changelog

All notable changes to the `@marketintellabs/hermes-paperclip-adapter` fork are documented here. The canonical source of release notes is the [GitHub Releases page](https://github.com/marketintellabs/hermes-paperclip-adapter/releases), which is what npmjs.com surfaces on the package page.

This file is a condensed, human-readable summary. For full context (test coverage, upgrade steps, related incidents), follow the GitHub Release link for each version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/) with the `-mil.N` prerelease suffix marking MIL fork releases.

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
