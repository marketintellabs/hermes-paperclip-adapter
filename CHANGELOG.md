# Changelog

All notable changes to the `@marketintellabs/hermes-paperclip-adapter` fork are documented here. The canonical source of release notes is the [GitHub Releases page](https://github.com/marketintellabs/hermes-paperclip-adapter/releases), which is what npmjs.com surfaces on the package page.

This file is a condensed, human-readable summary. For full context (test coverage, upgrade steps, related incidents), follow the GitHub Release link for each version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/) with the `-mil.N` prerelease suffix marking MIL fork releases.

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
