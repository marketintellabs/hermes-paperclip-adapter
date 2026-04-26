import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { unwrapUserEnv } from "./env-unwrap.js";

describe("env-unwrap", () => {
  it("returns empty for null / undefined / non-object", () => {
    assert.deepEqual(unwrapUserEnv(null), { env: {}, droppedKeys: [] });
    assert.deepEqual(unwrapUserEnv(undefined), { env: {}, droppedKeys: [] });
    assert.deepEqual(unwrapUserEnv("nope"), { env: {}, droppedKeys: [] });
    assert.deepEqual(unwrapUserEnv(42), { env: {}, droppedKeys: [] });
    assert.deepEqual(unwrapUserEnv(["a", "b"]), { env: {}, droppedKeys: [] });
  });

  it("passes plain string values through unchanged", () => {
    const r = unwrapUserEnv({
      ANTHROPIC_API_KEY: "sk-ant-direct",
      HERMES_HOME: "/data/hermes",
    });
    assert.equal(r.env.ANTHROPIC_API_KEY, "sk-ant-direct");
    assert.equal(r.env.HERMES_HOME, "/data/hermes");
    assert.deepEqual(r.droppedKeys, []);
  });

  it("unwraps Paperclip secret-ref shape { type, value }", () => {
    const r = unwrapUserEnv({
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-secret" },
      OPENROUTER_API_KEY: { type: "secret_ref", value: "sk-or-secret" },
    });
    assert.equal(r.env.ANTHROPIC_API_KEY, "sk-ant-secret");
    assert.equal(r.env.OPENROUTER_API_KEY, "sk-or-secret");
  });

  it("supports a mixed bag of plain + wrapped on the same input", () => {
    const r = unwrapUserEnv({
      PLAIN: "plain-value",
      WRAPPED: { value: "wrapped-value" },
      EMPTY: "",
    });
    assert.equal(r.env.PLAIN, "plain-value");
    assert.equal(r.env.WRAPPED, "wrapped-value");
    assert.equal(r.env.EMPTY, "");
    assert.deepEqual(r.droppedKeys, []);
  });

  it("drops wrappers whose value is not a string", () => {
    const r = unwrapUserEnv({
      BAD_NUMBER: { value: 42 },
      BAD_NULL: { value: null },
      BAD_NESTED: { value: { nested: "x" } },
      MISSING_VALUE: { type: "plain" },
    });
    assert.deepEqual(r.env, {});
    assert.deepEqual(r.droppedKeys.sort(), [
      "BAD_NESTED",
      "BAD_NULL",
      "BAD_NUMBER",
      "MISSING_VALUE",
    ]);
  });

  it("does NOT regress to '[object Object]' on the legacy bug shape", () => {
    // Pre-0.8.18 behaviour with Object.assign would have produced a
    // value of '[object Object]'. We assert the new helper never
    // allows that string to appear.
    const r = unwrapUserEnv({
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-real" },
    });
    assert.ok(!/\[object Object\]/.test(r.env.ANTHROPIC_API_KEY));
    assert.equal(r.env.ANTHROPIC_API_KEY, "sk-ant-real");
  });

  it("preserves non-string drops as a list (caller can log a single warning)", () => {
    const r = unwrapUserEnv({
      OK: "ok",
      DROP: { type: "plain" }, // missing value
    });
    assert.deepEqual(r.env, { OK: "ok" });
    assert.deepEqual(r.droppedKeys, ["DROP"]);
  });
});
