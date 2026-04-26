import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHealthCheck } from "./health-check.js";

function withTmpHome<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "hermes-health-"));
  return fn(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup races
    }
  });
}

describe("health-check: runHealthCheck", () => {
  it("returns pass when binary, home, state.db, and network are all healthy", async () => {
    await withTmpHome(async (home) => {
      const fakeFetch = (async () => ({
        ok: true,
        status: 200,
      })) as unknown as typeof fetch;

      // We won't actually have a hermes binary in CI, so override the
      // hermesCommand to `node` (always present) — it'll respond to
      // `--version`. The probe doesn't validate the output content,
      // just that the binary runs.
      const result = await runHealthCheck({
        hermesCommand: "node",
        hermesHome: home,
        fetchImpl: fakeFetch,
      });

      assert.equal(result.status, "pass");
      assert.equal(result.hermesHome, home);
      assert.ok(result.adapterVersion.length > 0);
      const binCheck = result.checks.find((c) => c.code === "hermes_binary");
      const homeCheck = result.checks.find((c) => c.code === "hermes_home_ok");
      const stateDbCheck = result.checks.find((c) => c.code === "state_db_absent");
      const orCheck = result.checks.find((c) => c.code === "openrouter_ok");
      assert.ok(binCheck, "binary check present");
      assert.equal(binCheck?.level, "info");
      assert.ok(homeCheck, "home check present");
      assert.ok(stateDbCheck, "state.db check present (file should be absent in tmp)");
      assert.ok(orCheck, "openrouter check present");
    });
  });

  it("fails when the hermes binary is missing", async () => {
    await withTmpHome(async (home) => {
      const fakeFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
      const result = await runHealthCheck({
        hermesCommand: "/nonexistent/path/to/hermes-xxx",
        hermesHome: home,
        fetchImpl: fakeFetch,
      });
      assert.equal(result.status, "fail");
      const binCheck = result.checks.find((c) => c.code === "hermes_binary");
      assert.equal(binCheck?.level, "error");
    });
  });

  it("fails when $HERMES_HOME does not exist", async () => {
    const fakeFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    const result = await runHealthCheck({
      hermesCommand: "node",
      hermesHome: "/nonexistent/hermes/home/xxx",
      fetchImpl: fakeFetch,
    });
    assert.equal(result.status, "fail");
    const homeCheck = result.checks.find((c) => c.code === "hermes_home_missing");
    assert.equal(homeCheck?.level, "error");
  });

  it("warns (not fails) when OpenRouter is unreachable", async () => {
    await withTmpHome(async (home) => {
      const fakeFetch = (async () => {
        throw new Error("ENOTFOUND openrouter.ai");
      }) as unknown as typeof fetch;
      const result = await runHealthCheck({
        hermesCommand: "node",
        hermesHome: home,
        fetchImpl: fakeFetch,
      });
      assert.equal(result.status, "warn");
      const orCheck = result.checks.find((c) => c.code === "openrouter_unreachable");
      assert.equal(orCheck?.level, "warn");
    });
  });

  it("warns when OpenRouter returns non-2xx", async () => {
    await withTmpHome(async (home) => {
      const fakeFetch = (async () => ({
        ok: false,
        status: 503,
      })) as unknown as typeof fetch;
      const result = await runHealthCheck({
        hermesCommand: "node",
        hermesHome: home,
        fetchImpl: fakeFetch,
      });
      assert.equal(result.status, "warn");
      const orCheck = result.checks.find((c) => c.code === "openrouter_unhealthy");
      assert.equal(orCheck?.level, "warn");
      assert.equal((orCheck?.detail as { status: number }).status, 503);
    });
  });

  it("skips the network probe when skipNetwork=true (offline mode)", async () => {
    await withTmpHome(async (home) => {
      const result = await runHealthCheck({
        hermesCommand: "node",
        hermesHome: home,
        skipNetwork: true,
      });
      const orCheck = result.checks.find((c) => c.code.startsWith("openrouter_"));
      assert.equal(orCheck, undefined, "no openrouter check should run");
    });
  });
});
