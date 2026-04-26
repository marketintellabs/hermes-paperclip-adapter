/**
 * Tests for `validateAgentSkills` — the runtime check that surfaces
 * declared-but-missing Hermes skills as a warning in the run transcript.
 *
 * The validator MUST be non-throwing and MUST treat any unreachable path
 * as missing (file or directory unreadable, ENOENT, EPERM, etc).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateAgentSkills, resolveSkillPath } from "./validate-skills.js";

interface FakeStats {
  isFile(): boolean;
}
const file: FakeStats = { isFile: () => true };
const dir: FakeStats = { isFile: () => false };

function makeStat(map: Record<string, FakeStats>): (p: string) => Promise<FakeStats> {
  return async (p: string) => {
    if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
}

describe("validateAgentSkills — empty config", () => {
  it("returns zero declared when no skills present", async () => {
    const result = await validateAgentSkills(
      {},
      { skillsRoot: "/skills", statImpl: makeStat({}) },
    );
    assert.equal(result.declared, 0);
    assert.deepEqual(result.found, []);
    assert.deepEqual(result.missing, []);
    assert.equal(result.skillsRoot, "/skills");
  });

  it("ignores empty string and whitespace-only entries", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "   ", hermes_skills: ["", "   ", null, 42, "skills/x.md"] as unknown[] },
      {
        skillsRoot: "/skills",
        statImpl: makeStat({ "/skills/skills/x.md": file }),
      },
    );
    assert.equal(result.declared, 1);
    assert.deepEqual(result.found, ["skills/x.md"]);
    assert.deepEqual(result.missing, []);
  });
});

describe("validateAgentSkills — single hermes_skill", () => {
  it("classifies a present file as found", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "skills/news-triage.md" },
      {
        skillsRoot: "/skills",
        statImpl: makeStat({ "/skills/skills/news-triage.md": file }),
      },
    );
    assert.equal(result.declared, 1);
    assert.deepEqual(result.found, ["skills/news-triage.md"]);
    assert.deepEqual(result.missing, []);
  });

  it("classifies a missing path as missing", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "skills/missing.md" },
      { skillsRoot: "/skills", statImpl: makeStat({}) },
    );
    assert.equal(result.declared, 1);
    assert.deepEqual(result.found, []);
    assert.deepEqual(result.missing, ["skills/missing.md"]);
  });

  it("classifies a directory as missing (not a file)", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "skills/whoops" },
      {
        skillsRoot: "/skills",
        statImpl: makeStat({ "/skills/skills/whoops": dir }),
      },
    );
    assert.equal(result.declared, 1);
    assert.deepEqual(result.missing, ["skills/whoops"]);
  });
});

describe("validateAgentSkills — hermes_skills array", () => {
  it("checks every entry and dedupes", async () => {
    const result = await validateAgentSkills(
      {
        hermes_skill: "skills/research-analysis.md",
        hermes_skills: [
          "skills/research-brief.md",
          "skills/persona-sarah-chen.md",
          "skills/research-brief.md", // dup
          "skills/research-analysis.md", // dup with hermes_skill
          "skills/missing.md",
        ],
      },
      {
        skillsRoot: "/data/hermes/skills",
        statImpl: makeStat({
          "/data/hermes/skills/skills/research-analysis.md": file,
          "/data/hermes/skills/skills/research-brief.md": file,
          "/data/hermes/skills/skills/persona-sarah-chen.md": file,
        }),
      },
    );
    assert.equal(result.declared, 4);
    assert.deepEqual(result.found.sort(), [
      "skills/persona-sarah-chen.md",
      "skills/research-analysis.md",
      "skills/research-brief.md",
    ]);
    assert.deepEqual(result.missing, ["skills/missing.md"]);
  });
});

describe("validateAgentSkills — path resolution", () => {
  it("honours absolute paths as-is", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "/etc/hermes/skills/global.md" },
      {
        skillsRoot: "/skills",
        statImpl: makeStat({ "/etc/hermes/skills/global.md": file }),
      },
    );
    assert.equal(result.found.length, 1);
    assert.equal(result.skillsRoot, "/skills");
  });

  it("uses HERMES_SKILLS_DIR env var when no explicit root provided", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "skills/x.md" },
      {
        envImpl: { HERMES_SKILLS_DIR: "/custom/efs/skills" },
        statImpl: makeStat({ "/custom/efs/skills/skills/x.md": file }),
      },
    );
    assert.equal(result.skillsRoot, "/custom/efs/skills");
    assert.deepEqual(result.found, ["skills/x.md"]);
  });

  it("falls back to /data/hermes/skills when env unset and no override", async () => {
    const result = await validateAgentSkills(
      { hermes_skill: "skills/x.md" },
      {
        envImpl: {},
        statImpl: makeStat({ "/data/hermes/skills/skills/x.md": file }),
      },
    );
    assert.equal(result.skillsRoot, "/data/hermes/skills");
    assert.deepEqual(result.found, ["skills/x.md"]);
  });
});

describe("validateAgentSkills — fault tolerance", () => {
  it("never throws on stat error — all paths unreachable become missing", async () => {
    const result = await validateAgentSkills(
      { hermes_skills: ["a.md", "b.md"] },
      {
        skillsRoot: "/skills",
        statImpl: async () => {
          throw new Error("EPERM");
        },
      },
    );
    assert.deepEqual(result.found, []);
    assert.deepEqual(result.missing.sort(), ["a.md", "b.md"]);
  });
});

describe("resolveSkillPath", () => {
  it("joins relative paths to the skills root", () => {
    assert.equal(
      resolveSkillPath("skills/x.md", "/data/hermes/skills"),
      "/data/hermes/skills/skills/x.md",
    );
  });

  it("returns absolute paths unchanged", () => {
    assert.equal(
      resolveSkillPath("/etc/hermes/global.md", "/skills"),
      "/etc/hermes/global.md",
    );
  });
});
