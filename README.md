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

**0.8.9-mil.0 — per-agent auxiliary-models override:** ready-but-
inert escape hatch for the cost regression in Hermes >= v2026.4.23
("v0.11.0"). Hermes makes background LLM calls outside the main
agent loop for `compression` (context summarisation), `vision`
(image parsing), `session_search` (hindsight retrieval), and
`title_generation` (auto-naming new sessions). v0.11.0 changed the
default for those calls from "use a cheap aggregator-side model"
to "use the main model" — which silently routes compression /
session_search / title_generation through whatever main model the
agent runs (Claude Opus, grok-4, etc.) when the consumer is an
OpenRouter or Nous Portal user. For an agent on Claude Opus 4.7,
that's roughly a 300x cost increase per auxiliary call.

The new `adapterConfig.auxiliaryModels` field accepts an arbitrary
map of slot name → slot config object, passed through verbatim to
the per-run `config.yaml` `auxiliary:` block. Slot-level merge
against the operator's `~/.hermes/config.yaml` — per-agent override
wins on collisions, operator-global slots not named in adapterConfig
survive untouched. The adapter emits no `auxiliary:` key when the
field is absent / null / `{}`, so the change is a no-op for anyone
not opting in (and a no-op against the currently-pinned Hermes
v2026.4.13, which ignores the block entirely). Recommended
OpenRouter-side defaults:

```yaml
auxiliaryModels:
  compression:
    provider: openrouter
    model: meta-llama/llama-3.1-8b-instruct
  session_search:
    provider: openrouter
    model: meta-llama/llama-3.1-8b-instruct
  title_generation:
    provider: openrouter
    model: meta-llama/llama-3.1-8b-instruct
```

The `[hermes] per-run config.yaml env: …` startup log now includes
`auxiliary=<bool>` so a missed override surfaces in
`stdout_excerpt` instead of weeks later in cost reports. Nine new
tests in `hermes-home.test.ts` cover no-override / override /
slot-collision / partial-merge / defensive-shape paths.

**0.8.10-mil.0 — test-mode model override:** process-wide flag that
swaps every spawn to a free OpenRouter model without touching any
agent / company / routine configuration. Set
`PAPERCLIP_ADAPTER_TEST_MODE=1` on the adapter process (or ECS task
definition) and ALL agents in that process route to a free model for
the duration of the run. Original `model` / `provider` /
`auxiliaryModels` from the agent's adapterConfig are ignored; the
prompt template, MCP tool allowlist, role/department/skills, and
routine schedule are unchanged. Defaults to the OpenRouter `openrouter/free`
meta-router (which auto-selects from free models that support
tool calling and structured output — required for the
`builtin:mil-heartbeat-v3` MCP-tool prompt). Pin to a specific slug
with `PAPERCLIP_ADAPTER_TEST_MODEL=google/gemma-4-31b-it:free` (or
similar). Auxiliary slots are forced to the same free model so test
mode is truly $0/run regardless of how Hermes' default-fallback
chain behaves.

A loud `[hermes] *** TEST MODE ACTIVE *** agent=<name> model=X->Y
provider=X->Y auxiliary=*->Y source=env detail="…"` banner is emitted
at the top of every spawn while active (the `source` field was added
in 0.8.11; in 0.8.10 the banner ended with `(set by
PAPERCLIP_ADAPTER_TEST_MODE=1)` instead), so a
single grep on production logs confirms (a) test mode is on and
(b) which agent's config was being used as the base. Off by default;
set to `0`/unset to revert to per-agent paid models with no
redeploy required (it's resolved at the start of each spawn). 13 new
unit tests in `test-mode.test.ts` cover truthiness parsing, default +
explicit overrides, whitespace trimming, banner formatting, and
inactive-mode safety.

Use cases: pre-flight smoke testing a new routine before letting it
fire on the paid model, reproducing a stuck-issue bug without
spending $5–$15 per attempt, validating that wake-on-assign + MCP +
status reconciliation work end-to-end after an infra change.

**0.8.11-mil.0 — per-issue test mode + sub-issue inheritance:** day-to-day
UX layer on top of 0.8.10. Operators (or the CEO agent) can flip a
*single* issue into test mode by either:

- including the explicit machine-readable marker `<!-- mode: test -->`
  in the issue body (canonical, zero false-positive risk), or
- using a natural-language intent phrase (`smoketest`, `smoke test`,
  `smoke-test`, `test mode`, `low-cost validation`, `test flow`) anywhere
  in the issue title or body.

The adapter probes each spawn's task title + body and, if either path
trips, routes that one work tree to the free OpenRouter model — every
other issue runs on its configured paid model. This closes the gap from
0.8.10's process-wide flag, which required a redeploy to flip on/off.

**Sub-issue inheritance.** When the MCP `create_sub_issue` tool runs
inside an adapter spawn that resolved to test mode, the adapter sets
`PAPERCLIP_TEST_MODE=1` on the MCP subprocess env and the tool prepends
`<!-- mode: test -->` plus an `inherited from parent: …` provenance
line to the sub-issue body before posting. The woken sub-agent then
probes its own issue and inherits test mode automatically — no
cross-process channel beyond the issue text the operator can see in the
Paperclip UI. Idempotent: parents that already wrote the marker into
their description don't double-add.

**Source-of-truth in the banner.** The `*** TEST MODE ACTIVE ***` line
now ends with `source=<env|issue-marker|issue-intent> detail="<phrase
or marker>"` so a single grep answers "where did this activation come
from?" — operator big-hammer, CEO's smoketest issue, or inherited from
a parent run.

**Activation priority:** env var > issue-marker > issue-intent > prod.
Env wins because it's the incident-response lever; per-issue activation
is the day-to-day UX. Recommended CEO prompt: *"Run a smoketest of the
system in low-cost validation mode. Validate pipeline integrity
end-to-end (wake-on-assign, MCP tool calls, status reconciliation,
sub-agent delegation). Don't worry about output quality — free models
are inconsistent under tool-use load."* Either phrase trips the
override, sub-agents inherit automatically. 24 new tests cover marker
detection, intent matching with false-positive guards, env-vs-issue
precedence, MCP env emission, sub-issue prepending, and idempotency.

Rollout is gated per-agent by `adapterConfig.promptTemplate`: flip one
agent to `builtin:mil-heartbeat-v3` at a time, flip back to v2 to roll
back. The 0.8.x hardening only kicks in on v3 runs. See the
[fork divergence list](./UPSTREAM.md#divergence-from-upstream)
(items 8–15) for the implementation sketch.

**0.8.12-mil.0 — fix per-issue test mode silently failing on the wake
path:** the per-issue marker / intent feature shipped in 0.8.11-mil.0
never actually fired in production. Paperclip's heartbeat wake snapshot
puts the issue title at `ctx.context.paperclipWake.issue.title` (NOT on
a top-level `taskTitle`) and **omits the issue body entirely** (the
harness assumes the agent will fetch it via the MCP `get_issue` tool).
The adapter's `resolveTestMode` was always called with `body=""`, so
the `<!-- mode: test -->` regex never matched. Every "smoketest" issue
silently downgraded to the configured paid model.

`execute()` now runs a new `enrichRunContext()` step before test-mode
resolution. Two layers, in order:

1. **Wake-snapshot title fallback** (synchronous, no I/O) — when the
   canonical `ctx.context → ctx.config` resolver returns empty for
   `taskTitle`, fall back to `ctx.context.paperclipWake.issue.title`.
   New `provenance: "wake-snapshot"` distinguishes this from
   `context` / `config` / `missing` in the diagnostic log.
2. **Authenticated body fetch** — when `taskBody` is still empty AND
   `ctx.authToken` (the per-run JWT Paperclip already mints) AND a
   reachable `paperclipApiUrl` are available, do
   `GET /api/issues/<taskId>` with a 3-second timeout. New
   `provenance: "api"`. Failure modes (`no_auth_token`, `http_404`,
   `timeout`, network error) are non-fatal — the run continues exactly
   as it would have on 0.8.11.

New diagnostic line on every successful enrichment:

```
[hermes] enriched run context: taskTitle=wake-snapshot,taskBody=api (api=18ms)
```

**Side effect (positive):** the `mil-heartbeat-v3` prompt template's
`{{taskBody}}` placeholder always rendered to `""` before this fix.
With enrichment it now expands to the real description, so agents see
the body in their first prompt instead of having to call MCP
`get_issue` to fetch it. One fewer round-trip per wake; net token cost
is roughly neutral (the body was going into context either way, just
one MCP turn later).

12 new tests in `run-context.test.ts` describe the actual production
context shape so future changes to the `ctx.context → taskBody`
plumbing fail unit tests, not end-to-end smoketests. **0.8.11-mil.x
users running per-issue test mode should bump to 0.8.12-mil.0;** the
process-wide `PAPERCLIP_ADAPTER_TEST_MODE=1` env var has always worked
and is unaffected.

**0.8.13-mil.0 — fix `create_sub_issue` orphans + missing wake on
delegated children:** uncovered during the Stage 3 paid-model retest
that followed 0.8.12. The MCP `create_sub_issue` tool was sending
`parentIssueId` in the POST body to Paperclip's
`POST /companies/:id/issues`. Paperclip's payload schema uses the
column-aligned name `parentId` and silently drops unknown fields, so
every successful sub-issue create landed with `parent_id = NULL`. The
parent never saw its children, status reconciliation didn't propagate,
and the test-mode-inheritance line in 0.8.11-mil.0 was harmless because
the tree was disconnected anyway.

The same POST also omitted `status`, so Paperclip defaulted it to
`backlog`. `backlog` does not fire the assignee's `on_assign`
heartbeat, so the delegated agent never woke — the work just sat
there. Once both fixes land together (`parentId: <uuid>` + `status:
"todo"` in the wire payload), delegation actually delegates: parent
calls the tool, Paperclip writes a `todo` issue under the right
`parent_id`, the assignee wakes within seconds via on-assign, and on
completion the parent's status reconciliation closes the loop.

The bug shipped because the existing happy-path test asserted
`body.parentIssueId === ...` — which was the field the adapter *sent*
but not the field Paperclip *read*. The new test fixtures the actual
API contract:

```js
assert.equal(body.parentId, "MAR-30");
assert.equal(body.parentIssueId, undefined);
assert.equal(body.status, "todo");
```

The LLM-facing tool input field is still named `parentIssueId`
(descriptive — pairs with `assigneeAgentId`, `companyId` in tool
docs); only the wire payload to Paperclip was renamed. Anyone using
the upstream adapter directly against Paperclip should bump.

**0.8.14-mil.0 — `result_json` clarity (model/provider populated,
marker_present renamed):** two follow-ups from the Stage 3 retest. (1)
`resultJson.modelUsed`, `provider`, and `providerSource` are now
populated on every successful run, sourced from the adapter's own
resolver (the same value it logs in the `[hermes] Starting Hermes
Agent (model=…, provider=…)` banner). Previously these fields were
only ever set when `parseHermesOutput` could grep them out of stdout,
which only happens on timed-out runs — meaning every clean successful
run logged `modelUsed: null`, making post-run "which model paid the
bill" queries impossible without ECS exec'ing into the container and
reading the NDJSON log file. (2) `result_marker_present` is the new
canonical name for the `RESULT:` marker boolean (the adapter-owned
status v2+ contract); `marker_present` is preserved as a deprecated
alias for one release because the old name was misleading — operators
reasonably read it as "test-mode marker present"
(`<!-- mode: test -->`), which is a different concept entirely. Both
fields hold the same value through 0.8.x; the alias will be removed in
0.9.0. `cost_usd` is still `null` for successful runs against Hermes
Agent v0.9.0 — that's an upstream Hermes Agent quiet-mode limitation
(no cost line in stdout), tracked as a separate follow-up to call
OpenRouter's generation endpoint after the run.

**0.8.15-mil.0 — observability bundle (skill preload validation +
soft-timeout warning):** two pure-add observability hooks that surface
silent failure modes BEFORE they become incidents. (1) `execute()` now
stat()s every path declared in `adapterConfig.hermes_skill` /
`hermes_skills` against the resolved skills root (`HERMES_SKILLS_DIR`,
falling back to `/data/hermes/skills`) before pre-flight; each
declared-but-missing skill produces a `[hermes] WARN: skill "<ref>"
declared in adapterConfig … but not found at <abspath> — Hermes will
run WITHOUT this skill` line on stderr, and a single rollup line on
stdout. Previously a renamed-or-unmounted skill file (`persona-sarah-chen.md`
moved on EFS, etc.) ran without the persona and the operator only
noticed because the output sounded wrong. (2) Soft-timeout warning at
80% of `timeoutSec` — `[hermes] WARN: soft-timeout reached at <N>s
(80% of <T>s hard limit). Run still in progress; consider raising
adapterConfig.timeoutSec if this becomes routine.` lands in the run
transcript so operators see "agents that consistently brush their
deadline" before one finally trips it. Threshold tunable via
`adapterConfig.softTimeoutThreshold` (any 0 < t < 1; default 0.8);
disable via `adapterConfig.softTimeoutWarn=false`. Both items are
non-fatal observability — no wire-format change, no prompt-template
change, no run-behaviour change. Companion to the Hermes Agent
v2026.4.23 (v0.11.0) bump: with `agent.api_max_retries` (Hermes
#14730) and activity-heartbeats (#10501) handling transient failures
upstream, persistent timeouts are now a clearer "this agent is genuinely
stuck" signal — exactly what soft-timeout warnings are designed to
surface early.

**0.8.16-mil.0 — `create_sub_issues` (plural) for parallel
delegation:** new MCP tool that takes one shared `parentIssueId` plus
an array of `subIssues` (capped at 10 per call) and POSTs them via
`Promise.allSettled`. Singular `create_sub_issue` is preserved
unchanged for one-off delegations; the plural form is the
delegator's bulk path. Three concrete wins for the CEO and Heads:
(1) one MCP-call-budget unit instead of N — a CEO decomposing one
investigation into 5 research streams used to burn 5 of the 20
`MAX_TOOL_CALLS` slots; the bulk path collapses that to 1, leaving
budget for follow-up comments and status updates without raising the
cap. (2) Wall-clock saving — 5 sequential POSTs typically cost 10–15
s of the run; parallel `Promise.allSettled` brings that to one RTT
bounded by the slowest child. (3) Partial-failure semantics — one
transient 503 on child #3 of 5 can't sink children #1, #2, #4, #5;
the LLM gets a per-item outcome array with per-index `retryPolicy`
and can retry only the failed indices. Aggregate retry policy is
escalated to `fix-args` if ANY child saw a 4xx in an all-failure
case, so the LLM stops looping on a malformed payload. Test-mode
marker inheritance is applied per child (idempotent), and the
wire-shape contract — `parentId` (NOT `parentIssueId`), explicit
`status: "todo"` so each child fires `on_assign` — lives in a single
shared `buildPayload` helper to defend the MAR-204/206/207
(2026-04-25) regression on every child of every batch. Allowlist
gate: agents with `can_delegate` need both `create_sub_issue` and
`create_sub_issues` in their `paperclipMcpTools` allowlist —
companion `paperclip/configure-agents.mjs` + `paperclip/apply-mcp-tools.mjs`
update grants both. Prompt template `builtin:mil-heartbeat-v3`
updated to advertise both with explicit guidance ("use plural when
delegating 2+ items at once"). Drive-by fix: `npm test` script now
quotes the `'dist/**/*.test.js'` glob so node's native glob
expansion picks up three-level-deep test files (was relying on `sh`
globstar which is off by default — silently skipped 54 tests
including the entire `tools.test.js` suite covering singular
`create_sub_issue`). Test count jumped 224 → 278 with no behaviour
change.

**0.8.16-mil.1 — README ordering fix + CI guard:** docs-only patch.
The in-flight section had drifted out of ascending order again
(0.8.16 / 0.8.15 / 0.8.14 appended at the wrong end of the section,
breaking the chronological flow established by entries 0.8.0
through 0.8.13 above them). Re-sorted so every entry once again
appears in ascending version order, matching how npmjs.com renders
the package page top-to-bottom. **Same shape of regression we
shipped patches for in 0.8.8-mil.2 and 0.8.11-mil.1**, so this
release also adds an automated CI guard
(`src/shared/readme-order.test.ts`) that parses every `**X.Y.Z-mil.N`
header and asserts the tuples are monotonically non-decreasing —
plus a cross-check that `package.json.version` is at-or-above the
latest README header, to catch the case where someone bumps the
package version but forgets to add the corresponding README entry.
Failure messages name the offending lines AND print the expected
ordering, so future regressions surface in CI with a single-glance
fix. No code changes from 0.8.16-mil.0; existing deployments do
not need to redeploy. Republished to npm so the package page picks
up the corrected README (npm only re-renders on a fresh publish).

**0.8.17-mil.0 — auto-repair detector (Hermes silent fuzzy
tool-name rewrites surfaced as loud alarms):** Hermes Agent's
Python tool-call parser fuzzy-matches every `<TOOLCALL>` block
against the agent's tool registry: if the LLM names a tool that
doesn't exist exactly — typo, stale name, or a brand-new tool the
worker isn't authorised for — Hermes silently rewrites the call
to the closest-matching registered tool, prints a single
`🔧 Auto-repaired tool name: 'X' -> 'Y'` line, and dispatches the
rewritten call. We caught this in production on the 0.8.16-mil.0
smoke test: a non-delegator worker calling
`mcp_paperclip_create_sub_issues` (a tool only delegators have on
their allowlist) was silently mapped to `mcp_paperclip_get_issue`
— the call "succeeded", returned garbage from the worker's POV,
and the actual decomposition the LLM intended never happened. No
alarm, no failed run, no telemetry — pure silent breakage. The
new detector watches the Hermes stream for the auto-repair
signature line, extracts the original→repaired tool names, and
(1) emits an `[hermes] ERROR: auto-repair: …` line on **stderr**
at the moment of detection so Paperclip's UI renders it in the
red error track, and (2) classifies the rewrite against the
agent's `paperclipMcpTools` allowlist — the alert message
explicitly says either "ORIGINAL tool was NOT in the per-agent
allowlist" (the high-signal failure case the production incident
hit) or "original tool IS in the per-agent allowlist (likely
typo or near-miss)" so the operator gets one-line triage. Every
detection is also written to `result_json.autoRepairs[]` (with
`original`, `repaired`, `unauthorized`, `ts`) plus the rollup
counters `result_json.autoRepairCount` and
`result_json.autoRepairUnauthorizedCount`, so dashboards find
these structurally without parsing log streams. Disable via
`adapterConfig.autoRepairAlerts = false`. Does NOT abort the run
— Hermes' auto-repair sometimes saves a benign typo and we don't
want to nuke working agents over it; loud + observable is the
contract, the operator decides policy from the structured record.
Lives in the adapter (not Hermes) because the fuzzy match runs in
Hermes' Python dispatcher *before* the call ever reaches the
MCP server, so the adapter can only tee the rewrite signal — not
prevent it. A future Hermes patch gating fuzzy match against the
per-agent registry would obviate this; until then the adapter is
the right shim. 12 new unit tests covering happy path, multi-line
chunks, CRLF, both bare and namespaced allowlist forms, opt-out,
all three classification states, and a false-positive guard.

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
| `paperclipMcpTools` | string[] | *(all)* | Per-agent MCP tool allowlist. `[]` = deny-all; absent = register every tool. See "Currently in flight" entry for 0.8.8 above. |
| `auxiliaryModels` | object | *(none)* | Per-agent override for Hermes' auxiliary-task models (`compression`, `vision`, `session_search`, `title_generation`, …). Passed through to `config.yaml` `auxiliary:` block. Slot-level merge with `~/.hermes/config.yaml`. No-op against Hermes < v2026.4.23. See 0.8.9 entry above. |
| `preflightSkip` | boolean | `true` | Skip the Hermes spawn when no work is assigned. Set `false` per-agent to opt out. See 0.8.7 entry above. |
| `softTimeoutWarn` | boolean | `true` | Emit a `[hermes] WARN: soft-timeout reached at <N>s …` line when the run crosses `softTimeoutThreshold` × `timeoutSec` (one-shot, observational only — never modifies run behaviour). Set `false` per-agent to opt out. See 0.8.15 entry above. |
| `softTimeoutThreshold` | number | `0.8` | Fraction of `timeoutSec` at which the soft-timeout warning fires. Must be strictly between `0` and `1`; out-of-range values fall back to `0.8`. Warning is also skipped if the resulting delay is < 5 s (too noisy to be useful at very short timeouts). |

### Test mode (per-issue UX + process-wide big-hammer)

Two ways to flip the adapter into test mode (both produce the same overrides — only the LLM endpoint is swapped to a free OpenRouter model). Activation priority: env > issue-marker > issue-intent > production.

**1. Per-issue (recommended day-to-day, 0.8.11+).** Add ANY of the following to the issue title or body:

- The explicit marker `<!-- mode: test -->` (canonical, zero false-positive risk).
- One of the intent phrases: `smoketest`, `smoke test`, `smoke-test`, `test mode`, `low-cost validation`, `test flow`.

The adapter probes each spawn's task title + body and routes that one issue's work tree to the free model. Sub-issues created via `create_sub_issue` (or `create_sub_issues` for bulk delegation, 0.8.16+) while in this mode automatically inherit the marker, so the whole delegation tree stays free until it terminates.

CEO prompt that reliably trips the override:

> *Run a smoketest of the system in low-cost validation mode. Validate pipeline integrity end-to-end (wake-on-assign, MCP tool calls, status reconciliation, sub-agent delegation). Don't worry about output quality — free models are inconsistent under tool-use load.*

**2. Process-wide env vars (operator big-hammer, incident response).** Set on the adapter process / ECS task definition. Apply to every spawn while present, regardless of per-agent `adapterConfig` or issue contents. See the 0.8.10 entry above for full semantics.

| Env var | Default | Description |
|---------|---------|-------------|
| `PAPERCLIP_ADAPTER_TEST_MODE` | unset | Truthy values (`1`, `true`, `yes`, `on`) activate test-mode override; anything else (including unset) leaves per-agent config untouched. |
| `PAPERCLIP_ADAPTER_TEST_MODEL` | `openrouter/free` | Model slug to use while test mode is active. The default is OpenRouter's meta-router that auto-selects free models supporting tool calling. |
| `PAPERCLIP_ADAPTER_TEST_PROVIDER` | `openrouter` | Provider to use while test mode is active. |
| `PAPERCLIP_ADAPTER_TEST_AUXILIARY_MODEL` | (same as `_TEST_MODEL`) | Optional. Override the auxiliary-slot model independently of the main model. All four slots (`compression`, `vision`, `session_search`, `title_generation`) are forced to this value. |

The `*** TEST MODE ACTIVE ***` banner emitted at the top of each spawn includes a `source=<env|issue-marker|issue-intent>` field plus the matched marker / phrase, so a single grep tells you which path activated test mode for that run.

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
