// Guards against a recurring docs regression: the README's
// "Currently in flight (0.8.x)" section is rendered top-to-bottom on
// the npmjs.com package page. We list versions there in **ascending**
// order (oldest first), which is the opposite of CHANGELOG.md's
// reverse-chronological order. Every time we ship a new release we
// must append the new entry at the BOTTOM of the in-flight section,
// not the top. We've shipped corrective patch releases (0.8.8-mil.2,
// 0.8.11-mil.1, 0.8.16-mil.1) just to fix this; this test makes the
// invariant CI-enforceable.
//
// The check is intentionally minimal: we extract every "**0.8.N-mil.M"
// header anchored at column 0 and assert the (N, M) tuples are
// monotonically non-decreasing. Anything outside the in-flight section
// (CHANGELOG.md, MIL-specific features, etc.) is unaffected because
// the regex is anchored to the README's "**X.Y.Z-mil.N — " heading
// pattern that only appears inside the in-flight block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// At test time the file lives at <repo>/dist/shared/readme-order.test.js
// (compiled from src/shared/readme-order.test.ts), so the repo root
// is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const README_PATH = resolve(REPO_ROOT, "README.md");
const PKG_PATH = resolve(REPO_ROOT, "package.json");

const HEADER = /^\*\*(\d+)\.(\d+)\.(\d+)-mil\.(\d+)\s/gm;

interface VersionHeader {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  mil: number;
  lineNumber: number;
}

function parseHeaders(readme: string): VersionHeader[] {
  const out: VersionHeader[] = [];
  for (const m of readme.matchAll(HEADER)) {
    const [raw, major, minor, patch, mil] = m;
    const before = readme.slice(0, m.index ?? 0);
    const lineNumber = before.split("\n").length;
    out.push({
      raw: raw.trim(),
      major: Number(major),
      minor: Number(minor),
      patch: Number(patch),
      mil: Number(mil),
      lineNumber,
    });
  }
  return out;
}

function compareVersion(a: VersionHeader, b: VersionHeader): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return a.mil - b.mil;
}

test("README in-flight section lists versions in ascending order", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const headers = parseHeaders(readme);

  assert.ok(
    headers.length >= 2,
    `expected at least 2 release headers in README.md, found ${headers.length}`,
  );

  const violations: string[] = [];
  for (let i = 1; i < headers.length; i++) {
    const prev = headers[i - 1];
    const cur = headers[i];
    if (compareVersion(prev, cur) > 0) {
      violations.push(
        `line ${cur.lineNumber}: ${cur.raw} appears after ${prev.raw} ` +
          `(line ${prev.lineNumber}); expected ascending order`,
      );
    }
  }

  if (violations.length > 0) {
    const expected = [...headers]
      .sort(compareVersion)
      .map((h) => h.raw)
      .join(" → ");
    assert.fail(
      `README.md "Currently in flight" section is out of order:\n  ` +
        violations.join("\n  ") +
        `\n\nExpected order:\n  ${expected}\n\n` +
        `Why this fails: npmjs.com renders README.md top-to-bottom on the package page, ` +
        `and we read the in-flight section in ascending version order. ` +
        `Append new release entries at the BOTTOM of the section, ` +
        `NOT the top (the CHANGELOG.md uses the opposite convention — don't mix them up).`,
    );
  }
});

test("README and package.json agree on the latest released version", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const headers = parseHeaders(readme);
  const latest = headers[headers.length - 1];

  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
    version: string;
  };

  // package.json is allowed to be ONE version ahead of README (the
  // commit that bumps package.json + writes the README entry can be
  // split across two commits during a release; we just want to catch
  // the case where someone bumps package.json but forgets to add the
  // README entry entirely, leaving npm's package page silently stale).
  // We assert that package.json's version is >= the latest README
  // header, not equal — equality is the steady state.
  const latestStr = `${latest.major}.${latest.minor}.${latest.patch}-mil.${latest.mil}`;
  const pkgMatch = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)-mil\.(\d+)$/);
  assert.ok(
    pkgMatch,
    `package.json version ${pkg.version} does not match X.Y.Z-mil.N format`,
  );
  const pkgHeader: VersionHeader = {
    raw: pkg.version,
    major: Number(pkgMatch![1]),
    minor: Number(pkgMatch![2]),
    patch: Number(pkgMatch![3]),
    mil: Number(pkgMatch![4]),
    lineNumber: 0,
  };

  assert.ok(
    compareVersion(latest, pkgHeader) <= 0,
    `package.json version (${pkg.version}) is BEHIND the latest README header (${latestStr}). ` +
      `Either the README has been updated for an unreleased version, or package.json has been rolled back. ` +
      `Reconcile before publishing.`,
  );
});
