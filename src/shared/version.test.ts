/**
 * Version-sync guard.
 *
 * Asserts that `ADAPTER_VERSION` (the runtime constant emitted in
 * `result_json.adapterVersion`, the MCP server connection banner, and
 * `runHealthCheck()` output) matches the version field in
 * `package.json`. These two MUST stay in lockstep on every release —
 * if they drift, every heartbeat run silently under-reports its
 * adapter version and operational tooling
 * (`bake-spotcheck.mjs`, `check-pilot.mjs`) starts lying.
 *
 * This exact regression actually shipped:
 *   - 0.9.2-mil.0 (PR #32) and 0.9.3-mil.0 (PR #33) both bumped
 *     package.json without bumping `src/shared/version.ts`. Production
 *     ran the new code but reported `adapterVersion: "0.9.1-mil.0"`
 *     for ~12 hours until a smoke test surfaced it.
 *
 * 0.9.4-mil.0 fixes the constant AND adds this test, which is wired
 * into the release workflow so it runs on every `npm run typecheck`
 * and every `npm test` in CI before publish.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTER_VERSION } from "./version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, "..", "..", "package.json");

describe("ADAPTER_VERSION", () => {
  it("matches package.json version (prevents the 0.9.2/0.9.3 silent under-report)", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
      version: string;
    };
    assert.equal(
      ADAPTER_VERSION,
      pkg.version,
      `src/shared/version.ts ADAPTER_VERSION="${ADAPTER_VERSION}" must match ` +
        `package.json version="${pkg.version}". When you bump the version in ` +
        `package.json for a release, also bump the constant in version.ts in ` +
        `the same commit. This test exists because 0.9.2 and 0.9.3 shipped ` +
        `without bumping the constant and produced ~12h of silently incorrect ` +
        `result_json.adapterVersion telemetry across the fleet.`,
    );
  });

  it("uses the -mil.N prerelease suffix (this is a fork, all releases are prereleases)", () => {
    assert.match(
      ADAPTER_VERSION,
      /^[0-9]+\.[0-9]+\.[0-9]+-mil\.[0-9]+$/,
      `ADAPTER_VERSION="${ADAPTER_VERSION}" must follow MAJOR.MINOR.PATCH-mil.N. ` +
        `The release workflow publishes via OIDC trusted publishing straight to ` +
        `the @latest dist-tag (see .github/workflows/release.yml); this fork has ` +
        `no non-prerelease stream, so @latest is effectively MIL.`,
    );
  });
});
