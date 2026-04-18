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
5. **Post-run safety-net reconciler** (0.3.2-mil.0): for legacy templates
   only, after a successful Hermes exit the adapter GETs the issue and
   PATCHes it to `done` if it is still `todo`/`in_progress`. Closes a
   race with upstream Paperclip's `reconcileStrandedAssignedIssues`
   watchdog.
6. **Release workflow**: `.github/workflows/release.yml` publishes to npm on
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
