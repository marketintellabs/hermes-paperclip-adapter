import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTranscriptCap } from "./transcript-cap.js";

describe("transcript-cap", () => {
  it("passes through every chunk when max=0 (disabled)", () => {
    const cap = createTranscriptCap({ max: 0 });
    for (let i = 0; i < 200; i += 1) {
      const out = cap.shouldForward("stdout", `line ${i}\n`);
      assert.equal(out, `line ${i}\n`);
    }
    assert.equal(cap.truncated(), false);
    assert.equal(cap.suppressed(), 0);
  });

  it("forwards up to max chunks then emits a single truncation notice", () => {
    const cap = createTranscriptCap({ max: 3 });
    assert.equal(cap.shouldForward("stdout", "a\n"), "a\n");
    assert.equal(cap.shouldForward("stdout", "b\n"), "b\n");
    assert.equal(cap.shouldForward("stdout", "c\n"), "c\n");

    const fourth = cap.shouldForward("stdout", "d\n");
    assert.notEqual(fourth, null);
    assert.match(fourth as string, /transcript truncated: cap=3/);
    assert.equal(cap.truncated(), true);

    assert.equal(cap.shouldForward("stdout", "e\n"), null);
    assert.equal(cap.shouldForward("stdout", "f\n"), null);
    assert.equal(cap.suppressed(), 3);
  });

  it("never suppresses adapter diagnostic lines, even past the cap", () => {
    const cap = createTranscriptCap({ max: 1 });
    assert.equal(cap.shouldForward("stdout", "noisy chunk 1\n"), "noisy chunk 1\n");

    const past = cap.shouldForward("stdout", "noisy chunk 2\n");
    assert.match(past as string, /transcript truncated/);

    const diag = cap.shouldForward(
      "stderr",
      "[hermes] WARN: soft-timeout reached at 240s\n",
    );
    assert.equal(
      diag,
      "[hermes] WARN: soft-timeout reached at 240s\n",
      "adapter diagnostic must always be forwarded",
    );

    const exitLine = cap.shouldForward(
      "stdout",
      "[hermes] Exit code: 0, timed out: false\n",
    );
    assert.equal(
      exitLine,
      "[hermes] Exit code: 0, timed out: false\n",
    );

    // A non-diagnostic chunk after the cap remains suppressed.
    assert.equal(cap.shouldForward("stdout", "tail llm output\n"), null);
  });

  it("recognises adapter diagnostics with leading whitespace", () => {
    const cap = createTranscriptCap({ max: 0 });
    const out = cap.shouldForward("stderr", "  [hermes] preload skill missing: foo\n");
    assert.match(out as string, /\[hermes\]/);
  });

  it("counts observed chunks even when forwarded as-is", () => {
    const cap = createTranscriptCap({ max: 5 });
    for (let i = 0; i < 4; i += 1) {
      cap.shouldForward("stdout", `${i}\n`);
    }
    assert.equal(cap.observed(), 4);
    assert.equal(cap.suppressed(), 0);
    assert.equal(cap.truncated(), false);
  });

  it("emits the truncation notice exactly once", () => {
    const cap = createTranscriptCap({ max: 2 });
    cap.shouldForward("stdout", "a\n");
    cap.shouldForward("stdout", "b\n");
    const first = cap.shouldForward("stdout", "c\n");
    const second = cap.shouldForward("stdout", "d\n");
    const third = cap.shouldForward("stdout", "e\n");
    assert.match(first as string, /transcript truncated/);
    assert.equal(second, null);
    assert.equal(third, null);
  });
});
