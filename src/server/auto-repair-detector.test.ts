import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAutoRepairDetector,
  formatAutoRepairAlert,
} from "./auto-repair-detector.js";

const SAMPLE_LINE =
  "🔧 Auto-repaired tool name: 'mcp_paperclip_create_sub_issues' -> 'mcp_paperclip_get_issue'\n";

test("detector returns no alerts on benign chunks", () => {
  const det = createAutoRepairDetector();
  assert.deepEqual(det.observe("hello world\n[done] ┊ 💻 ls 0.1s\n"), []);
  assert.equal(det.detections().length, 0);
});

test("detector extracts original and repaired tool names", () => {
  const det = createAutoRepairDetector();
  const alerts = det.observe(SAMPLE_LINE);
  assert.equal(alerts.length, 1);
  const [d] = det.detections();
  assert.equal(d.original, "mcp_paperclip_create_sub_issues");
  assert.equal(d.repaired, "mcp_paperclip_get_issue");
});

test("detector handles multi-line chunks", () => {
  const det = createAutoRepairDetector();
  const chunk = `random line\n${SAMPLE_LINE}another line\n${SAMPLE_LINE}`;
  const alerts = det.observe(chunk);
  assert.equal(alerts.length, 2);
  assert.equal(det.detections().length, 2);
});

test("detector handles CRLF line endings", () => {
  const det = createAutoRepairDetector();
  const chunk = SAMPLE_LINE.replace("\n", "\r\n");
  const alerts = det.observe(chunk);
  assert.equal(alerts.length, 1);
});

test("detector classifies unauthorized when original NOT in allowlist", () => {
  const det = createAutoRepairDetector({
    // Worker that has read-only access. `create_sub_issues` is missing.
    allowedTools: ["get_issue", "list_my_issues", "post_issue_comment"],
  });
  det.observe(SAMPLE_LINE);
  const [d] = det.detections();
  assert.equal(d.unauthorized, true);
});

test("detector classifies authorized when original IS in allowlist", () => {
  const det = createAutoRepairDetector({
    // Operator has the bare name in the allowlist (the canonical form
    // configure-agents.mjs writes); the auto-repair was a near-miss.
    allowedTools: ["create_sub_issues", "create_sub_issue", "get_issue"],
  });
  det.observe(SAMPLE_LINE);
  const [d] = det.detections();
  assert.equal(d.unauthorized, false);
});

test("detector also accepts the namespaced allowlist form", () => {
  const det = createAutoRepairDetector({
    allowedTools: ["mcp_paperclip_create_sub_issues", "mcp_paperclip_get_issue"],
  });
  det.observe(SAMPLE_LINE);
  const [d] = det.detections();
  assert.equal(d.unauthorized, false);
});

test("detector returns null when no allowlist supplied", () => {
  const det = createAutoRepairDetector();
  det.observe(SAMPLE_LINE);
  assert.equal(det.detections()[0].unauthorized, null);
});

test("disabled detector ignores everything", () => {
  const det = createAutoRepairDetector({ enabled: false });
  assert.deepEqual(det.observe(SAMPLE_LINE), []);
  assert.equal(det.detections().length, 0);
});

test("alert message names the unauthorized case explicitly", () => {
  const msg = formatAutoRepairAlert({
    original: "mcp_paperclip_create_sub_issues",
    repaired: "mcp_paperclip_get_issue",
    unauthorized: true,
    ts: "2026-04-26T18:00:00Z",
  });
  assert.match(msg, /\[hermes\] ERROR: auto-repair:/);
  assert.match(
    msg,
    /'mcp_paperclip_create_sub_issues' → 'mcp_paperclip_get_issue'/,
  );
  assert.match(msg, /NOT in the per-agent allowlist/);
});

test("alert message distinguishes near-miss from unauthorized", () => {
  const nearMiss = formatAutoRepairAlert({
    original: "mcp_paperclip_create_sub_issues",
    repaired: "mcp_paperclip_get_issue",
    unauthorized: false,
    ts: "2026-04-26T18:00:00Z",
  });
  assert.match(nearMiss, /typo or near-miss/);

  const noAllowlist = formatAutoRepairAlert({
    original: "mcp_paperclip_create_sub_issues",
    repaired: "mcp_paperclip_get_issue",
    unauthorized: null,
    ts: "2026-04-26T18:00:00Z",
  });
  assert.match(noAllowlist, /no per-agent allowlist configured/);
});

test("non-auto-repair line containing the wrench emoji is NOT matched", () => {
  // Tool result lines may legitimately contain 🔧 in their detail text
  // (e.g. an LLM commenting "🔧 Auto-repaired = bad"). The pattern is
  // anchored on the literal Hermes prefix so it shouldn't false-positive.
  const det = createAutoRepairDetector();
  const alerts = det.observe(
    "  ┊ 💬 We should never see 🔧 Auto-repaired show up\n",
  );
  // The trailing exact pattern is what triggers a match; here it isn't
  // present in canonical form.
  assert.equal(alerts.length, 0);
});
