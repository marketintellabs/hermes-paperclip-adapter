/**
 * Tests for the v3 bypass detector.
 *
 * The detector is high-precision by design: false positives mean a
 * compliant agent gets tagged and someone wastes an hour chasing a
 * regex that matched a doc comment. Every pattern added here should
 * have an "expected match" AND a "near-miss that MUST NOT match" test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scanForBypass, DEFAULT_BYPASS_PATTERNS } from "./bypass-detector.js";

describe("scanForBypass — paperclip_localhost", () => {
  it("flags http://localhost:3100/api/issues/", () => {
    const r = scanForBypass(
      "I will run curl http://localhost:3100/api/issues/MAR-29",
      "",
    );
    assert.equal(r.flagged, true);
    assert.equal(r.primaryPattern, "paperclip_localhost");
    assert.equal(r.matches[0].pattern, "paperclip_localhost");
  });

  it("flags http://127.0.0.1:3100/api/issues/", () => {
    const r = scanForBypass("curl http://127.0.0.1:3100/api/companies/x", "");
    assert.equal(r.flagged, true);
  });

  it("flags http://paperclip:3100/api/... (container DNS)", () => {
    const r = scanForBypass("fetching http://paperclip:3100/api/issues", "");
    assert.equal(r.flagged, true);
  });

  it("does NOT flag http://localhost:3100/docs (non-API path)", () => {
    const r = scanForBypass(
      "see http://localhost:3100/docs for the spec",
      "",
    );
    assert.equal(r.flagged, false);
  });
});

describe("scanForBypass — curl_paperclip", () => {
  it("flags a curl hitting /issues/", () => {
    const r = scanForBypass("curl https://ops.marketintellabs.com/api/issues/MAR-1", "");
    assert.equal(r.flagged, true);
  });

  it("flags a curl with -X PATCH against /api/", () => {
    const r = scanForBypass(
      "curl -X PATCH https://ops.marketintellabs.com/api/issues/MAR-1 -d 'status=done'",
      "",
    );
    assert.equal(r.flagged, true);
  });

  it("does NOT flag curl against an unrelated domain", () => {
    const r = scanForBypass(
      "curl https://finance.yahoo.com/quote/AAPL",
      "",
    );
    assert.equal(r.flagged, false);
  });

  it("does NOT flag the word 'curl' alone in prose", () => {
    const r = scanForBypass("the user wants a curl example in the output", "");
    assert.equal(r.flagged, false);
  });
});

describe("scanForBypass — wget_paperclip", () => {
  it("flags wget against /api/", () => {
    const r = scanForBypass("wget http://localhost:3100/api/issues/x", "");
    assert.equal(r.flagged, true);
  });

  it("does NOT flag wget against /docs", () => {
    const r = scanForBypass("wget https://example.com/docs/guide.pdf", "");
    assert.equal(r.flagged, false);
  });
});

describe("scanForBypass — behavior", () => {
  it("dedupes identical matches (same pattern + snippet) so a chatty agent only scores once", () => {
    const text = [
      "curl http://localhost:3100/api/issues/MAR-29",
      "curl http://localhost:3100/api/issues/MAR-29",
      "curl http://localhost:3100/api/issues/MAR-29",
    ].join("\n");
    const r = scanForBypass(text, "");
    assert.equal(r.flagged, true);
    assert.equal(r.matches.length, 1, "duplicates must collapse");
  });

  it("scans stderr in addition to stdout", () => {
    const r = scanForBypass(
      "",
      "% Total    % Received % Xferd Average  Speed\ncurl -X POST http://localhost:3100/api/issues/",
    );
    assert.equal(r.flagged, true);
  });

  it("returns all matches up to the cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`curl http://localhost:3100/api/issues/MAR-${i}`);
    }
    const r = scanForBypass(lines.join("\n"), "");
    assert.equal(r.flagged, true);
    assert.ok(r.matches.length <= 10, `matches should be capped, got ${r.matches.length}`);
  });

  it("picks the HIGHEST-severity pattern as primary (localhost beats curl)", () => {
    // Both patterns match the same string, but paperclip_localhost is
    // declared first in DEFAULT_BYPASS_PATTERNS. The primary slot
    // should reflect the most specific pattern that fired.
    const r = scanForBypass("curl http://localhost:3100/api/issues/x", "");
    assert.equal(r.flagged, true);
    assert.equal(r.primaryPattern, "paperclip_localhost");
  });

  it("returns not-flagged + empty matches for clean output", () => {
    const r = scanForBypass(
      "I called list_my_issues. I then called post_issue_comment. Done.",
      "",
    );
    assert.equal(r.flagged, false);
    assert.equal(r.matches.length, 0);
    assert.equal(r.primaryPattern, null);
  });

  it("snippet is trimmed + single-space normalized for readability", () => {
    const r = scanForBypass(
      "\n\n    curl http://localhost:3100/api/issues/MAR-29   \n",
      "",
    );
    assert.ok(!r.matches[0].snippet.includes("\n"));
    assert.ok(!r.matches[0].snippet.startsWith(" "));
  });
});

describe("scanForBypass — DEFAULT_BYPASS_PATTERNS registry shape", () => {
  it("every pattern has a name, regex, and why string", () => {
    for (const p of DEFAULT_BYPASS_PATTERNS) {
      assert.ok(p.name.length > 0, "pattern needs name");
      assert.ok(p.regex instanceof RegExp, "pattern needs regex");
      assert.ok(p.why.length > 0, "pattern needs why explanation");
    }
  });

  it("has at least the 4 initial patterns (localhost, curl, wget, fetch)", () => {
    const names = new Set(DEFAULT_BYPASS_PATTERNS.map((p) => p.name));
    assert.ok(names.has("paperclip_localhost"));
    assert.ok(names.has("curl_paperclip"));
    assert.ok(names.has("wget_paperclip"));
    assert.ok(names.has("node_http_request"));
  });
});
