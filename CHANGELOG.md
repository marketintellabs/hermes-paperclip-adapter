# Changelog

All notable changes to the `@marketintellabs/hermes-paperclip-adapter` fork are documented here. The canonical source of release notes is the [GitHub Releases page](https://github.com/marketintellabs/hermes-paperclip-adapter/releases), which is what npmjs.com surfaces on the package page.

This file is a condensed, human-readable summary. For full context (test coverage, upgrade steps, related incidents), follow the GitHub Release link for each version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/) with the `-mil.N` prerelease suffix marking MIL fork releases.

## [0.8.8-mil.0] — 2026-04-22

### Added
- **Per-agent MCP tool allowlist.** `buildServer({allowedTools})` now filters `ALL_TOOLS` to a per-agent list. Propagated end-to-end via the `PAPERCLIP_MCP_TOOLS=<comma,separated>` env var on the per-run `config.yaml` (three states: unset → register all; `""` → deny-all; `"a,b,c"` → allowlist).
- Exported helpers `parseAllowedToolsEnv` and `resolveToolsToRegister` for unit tests.
- 11 new tests covering allowlist filtering, env-var round-trip (unset/empty/list), and unknown-name tolerance.

### Changed
- **`create_sub_issue` now REQUIRES `parentIssueId`.** Previously optional; empty/blank now returns `retryPolicy=fix-args` with `MISSING_PARENT` audit log. Combined with the existing `assertWriteScope`, agents can only create sub-tasks of the issue they're actively working on — top-level issues come only from humans or Paperclip Routines.

### Why
Second half of the [2026-04-04 autonomous-work-loop fix](https://github.com/marketintellabs/marketintellabs/blob/main/docs/incidents/2026-04-04-autonomous-work-loop.md). Closes the structural path that let the CEO agent fabricate 49 top-level issues in one day.

[Full release notes →](https://github.com/marketintellabs/hermes-paperclip-adapter/releases/tag/v0.8.8-mil.0)

## [0.8.7-mil.0] — 2026-04-22

### Added
- **Adapter pre-flight check.** Before invoking Hermes, query `GET /companies/:id/issues?assigneeAgentId=:agent` and skip the spawn (returning `resultJson.preflight: "skipped"`) if zero open issues are assigned. Fail-open on any ambiguity — the pre-flight is an optimization, not a correctness barrier.
- New `config.preflightSkip` per-agent opt-out.
- 8 new tests covering explicit-task bypass, fail-open paths, and skip decisions.

### Why
First half of the 2026-04-04 autonomous-work-loop fix. Stops the "wake → zero-work LLM call → \$0.05–\$0.50 burned" pattern that was the primary driver of a \$100/day credit burn when multiplied across 15 idling agents.

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
