/**
 * Tests for per-run HERMES_HOME construction.
 *
 * These are the only file-system-touching tests in the suite — they use
 * tmp dirs and clean up after themselves. They're valuable because a
 * silent bug in the YAML merge or the symlink scheme would manifest
 * as "MCP tools not discovered" in production, with no good failure
 * signal short of a MAR-30 smoke.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  buildMcpServerSpec,
  buildPerRunHermesHome,
  mergeMcpServerIntoConfig,
} from "./hermes-home.js";

async function makeFakeHome(overrides: {
  extraEntries?: Record<string, string>;
  baseConfig?: string;
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-hermes-home-"));
  await mkdir(join(dir, "sessions"));
  await mkdir(join(dir, "skills"));
  await writeFile(join(dir, ".env"), "OPENROUTER_API_KEY=stub\n");
  if (overrides.baseConfig !== undefined) {
    await writeFile(join(dir, "config.yaml"), overrides.baseConfig);
  }
  for (const [name, body] of Object.entries(overrides.extraEntries ?? {})) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

const MCP_CLI = "/app/dist/mcp/cli.js";

describe("buildMcpServerSpec", () => {
  it("emits only the env vars that are set (agentId/companyId/issueId are optional)", () => {
    const spec = buildMcpServerSpec(
      {
        apiUrl: "http://paperclip/api",
        apiKey: "jwt",
      },
      MCP_CLI,
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(env.PAPERCLIP_API_URL, "http://paperclip/api");
    assert.equal(env.PAPERCLIP_API_KEY, "jwt");
    assert.equal(env.PAPERCLIP_AGENT_ID, undefined);
    assert.equal(env.PAPERCLIP_ISSUE_ID, undefined);
  });

  it("includes issueId when provided (the scope boundary)", () => {
    const spec = buildMcpServerSpec(
      {
        apiUrl: "http://paperclip/api",
        apiKey: "jwt",
        issueId: "MAR-30",
        agentId: "ag",
        companyId: "co",
        runId: "rn",
      },
      MCP_CLI,
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(env.PAPERCLIP_ISSUE_ID, "MAR-30");
    assert.equal(env.PAPERCLIP_AGENT_ID, "ag");
    assert.equal(env.PAPERCLIP_COMPANY_ID, "co");
    assert.equal(env.PAPERCLIP_RUN_ID, "rn");
  });

  it("points at node + the absolute cli path", () => {
    const spec = buildMcpServerSpec(
      { apiUrl: "x", apiKey: "y" },
      MCP_CLI,
    ) as { command: string; args: string[]; enabled: boolean };
    assert.equal(spec.command, "node");
    assert.deepEqual(spec.args, [MCP_CLI]);
    assert.equal(spec.enabled, true);
  });

  it("injects telemetry paths into env when provided (audit + liveness)", () => {
    const spec = buildMcpServerSpec(
      { apiUrl: "http://pc/api", apiKey: "jwt" },
      MCP_CLI,
      {
        auditLogPath: "/tmp/run-x/mcp-tool-calls.ndjson",
        livenessFilePath: "/tmp/run-x/mcp-liveness.json",
      },
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(env.PAPERCLIP_MCP_AUDIT_LOG, "/tmp/run-x/mcp-tool-calls.ndjson");
    assert.equal(env.PAPERCLIP_MCP_LIVENESS_FILE, "/tmp/run-x/mcp-liveness.json");
  });

  it("omits telemetry env vars when telemetry paths are absent (backwards compat)", () => {
    const spec = buildMcpServerSpec(
      { apiUrl: "x", apiKey: "y" },
      MCP_CLI,
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(env.PAPERCLIP_MCP_AUDIT_LOG, undefined);
    assert.equal(env.PAPERCLIP_MCP_LIVENESS_FILE, undefined);
  });

  it("emits PAPERCLIP_MCP_TOOLS (comma-separated) when allowedTools is set", () => {
    const spec = buildMcpServerSpec(
      {
        apiUrl: "http://pc/api",
        apiKey: "jwt",
        allowedTools: ["list_my_issues", "get_issue", "post_issue_comment"],
      },
      MCP_CLI,
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(
      env.PAPERCLIP_MCP_TOOLS,
      "list_my_issues,get_issue,post_issue_comment",
    );
  });

  it("emits an empty PAPERCLIP_MCP_TOOLS when allowedTools is [] (deny-all)", () => {
    // Empty array = explicit deny-all, different from "no allowlist".
    // We must still set the env var so the MCP server sees an empty
    // allowlist (not null), otherwise the subprocess falls through to
    // "register all tools".
    const spec = buildMcpServerSpec(
      { apiUrl: "http://pc/api", apiKey: "jwt", allowedTools: [] },
      MCP_CLI,
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(env.PAPERCLIP_MCP_TOOLS, "");
  });

  it("omits PAPERCLIP_MCP_TOOLS entirely when allowedTools is undefined", () => {
    const spec = buildMcpServerSpec(
      { apiUrl: "http://pc/api", apiKey: "jwt" },
      MCP_CLI,
    );
    const env = (spec as { env: Record<string, string> }).env;
    assert.equal(env.PAPERCLIP_MCP_TOOLS, undefined);
  });
});

describe("mergeMcpServerIntoConfig", () => {
  it("preserves the operator's other mcp_servers entries (gmail, github, ...)", () => {
    // Regression guard: if we ever accidentally replace the whole
    // mcp_servers map instead of merging, every container loses its
    // other MCP integrations on the first v3 run. Tested because it's
    // silent and hard to notice until someone complains their github
    // tools vanished.
    const base = `
model:
  default: openrouter/anthropic/claude-sonnet-4.5
mcp_servers:
  gmail:
    command: gmail-mcp
    enabled: true
  github:
    command: github-mcp
    enabled: true
logging:
  level: info
`;
    const merged = mergeMcpServerIntoConfig(
      base,
      { apiUrl: "http://pc/api", apiKey: "jwt", issueId: "MAR-30" },
      MCP_CLI,
    );
    const parsed = parseYaml(merged) as {
      mcp_servers: Record<string, unknown>;
      model: unknown;
      logging: unknown;
    };
    assert.ok(parsed.mcp_servers.gmail, "gmail should still be there");
    assert.ok(parsed.mcp_servers.github, "github should still be there");
    assert.ok(parsed.mcp_servers.paperclip, "paperclip should be added");
    assert.ok(parsed.model, "unrelated top-level keys survived");
    assert.ok(parsed.logging, "unrelated top-level keys survived");
  });

  it("handles empty base config (fresh container with no ~/.hermes/config.yaml)", () => {
    const merged = mergeMcpServerIntoConfig(
      "",
      { apiUrl: "http://pc/api", apiKey: "jwt" },
      MCP_CLI,
    );
    const parsed = parseYaml(merged) as { mcp_servers: { paperclip: unknown } };
    assert.ok(parsed.mcp_servers.paperclip);
  });

  it("overwrites an existing paperclip entry (stale config shouldn't win)", () => {
    const base = `
mcp_servers:
  paperclip:
    command: stale
    args: [stale.js]
`;
    const merged = mergeMcpServerIntoConfig(
      base,
      { apiUrl: "http://pc/api", apiKey: "jwt", issueId: "MAR-30" },
      MCP_CLI,
    );
    const parsed = parseYaml(merged) as {
      mcp_servers: { paperclip: { args: string[]; env: Record<string, string> } };
    };
    assert.deepEqual(parsed.mcp_servers.paperclip.args, [MCP_CLI]);
    assert.equal(parsed.mcp_servers.paperclip.env.PAPERCLIP_ISSUE_ID, "MAR-30");
  });
});

describe("buildPerRunHermesHome", () => {
  it("symlinks sessions/skills/.env from real home, writes fresh config.yaml", async () => {
    const realHome = await makeFakeHome({
      baseConfig: "model:\n  default: claude-sonnet-4.5\n",
    });
    try {
      const run = await buildPerRunHermesHome(
        "test-run-1",
        {
          apiUrl: "http://pc/api",
          apiKey: "jwt",
          issueId: "MAR-30",
          agentId: "ag",
        },
        { realHome, mcpCliPath: MCP_CLI },
      );
      try {
        // config.yaml is a REAL file with our injected block.
        const configStat = await lstat(join(run.path, "config.yaml"));
        assert.equal(configStat.isFile(), true);
        assert.equal(configStat.isSymbolicLink(), false);
        const config = parseYaml(
          await readFile(join(run.path, "config.yaml"), "utf-8"),
        ) as { mcp_servers: { paperclip: { env: Record<string, string> } }; model: unknown };
        assert.equal(config.mcp_servers.paperclip.env.PAPERCLIP_ISSUE_ID, "MAR-30");
        assert.ok(config.model, "base model config preserved");

        // sessions + skills + .env are symlinks to the real home.
        for (const name of ["sessions", "skills", ".env"]) {
          const st = await lstat(join(run.path, name));
          assert.equal(st.isSymbolicLink(), true, `${name} should be a symlink`);
        }
      } finally {
        await run.cleanup();
      }
      // After cleanup the run dir is gone.
      await assert.rejects(
        readdir(run.path),
        /ENOENT/,
        "cleanup should remove the run dir",
      );
    } finally {
      await rm(realHome, { recursive: true, force: true });
    }
  });

  it("sanitizes runId so weird characters can't escape /tmp", async () => {
    // runId values come from Paperclip; we treat them as trusted-but-
    // not-sterile. Sanitizer strips anything that could traverse paths
    // or confuse shell tooling inspecting /tmp.
    const realHome = await makeFakeHome();
    try {
      const run = await buildPerRunHermesHome(
        "../../etc/passwd",
        { apiUrl: "http://pc/api", apiKey: "jwt" },
        { realHome, mcpCliPath: MCP_CLI },
      );
      try {
        assert.match(run.path, /paperclip-run-/);
        assert.doesNotMatch(run.path, /etc\/passwd/);
        assert.ok(!run.path.includes(".."));
      } finally {
        await run.cleanup();
      }
    } finally {
      await rm(realHome, { recursive: true, force: true });
    }
  });

  it("tolerates a missing real home (local tests, fresh container)", async () => {
    // No real home exists. buildPerRunHermesHome should still produce a
    // working HERMES_HOME — hermes will create sessions/logs on demand.
    const run = await buildPerRunHermesHome(
      "test-run-no-home",
      { apiUrl: "http://pc/api", apiKey: "jwt" },
      {
        realHome: join(tmpdir(), "does-not-exist-" + Date.now()),
        mcpCliPath: MCP_CLI,
      },
    );
    try {
      const configExists = await readFile(join(run.path, "config.yaml"), "utf-8");
      assert.match(configExists, /paperclip/);
    } finally {
      await run.cleanup();
    }
  });
});
