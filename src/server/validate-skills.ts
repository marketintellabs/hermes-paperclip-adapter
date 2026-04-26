/**
 * Runtime validation of `hermes_skill` / `hermes_skills` declared in an
 * agent's `adapterConfig`.
 *
 * Hermes silently ignores a missing skill file at run time — the agent
 * just runs without that persona/skill loaded, and the operator only
 * notices later because the output sounds wrong (e.g. a Sarah Chen run
 * that doesn't sound like Sarah Chen).
 *
 * This validator runs once at the top of `execute()` and surfaces every
 * declared-but-missing skill as a `[hermes] WARN:` line in the run
 * transcript. It NEVER throws — validation failure is non-fatal so a
 * filesystem hiccup doesn't break a real run.
 *
 * Skills are referenced by paths relative to the adapter's skills root
 * (`HERMES_SKILLS_DIR` env var, or `/data/hermes/skills` as a final
 * fallback). Absolute paths are honoured as-is.
 */

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SKILLS_ROOT = "/data/hermes/skills";

export interface SkillValidationResult {
  /** Number of distinct skill paths declared in adapterConfig. */
  declared: number;
  /** Skill paths that resolved to a readable file on disk. */
  found: string[];
  /** Skill paths that could not be located. */
  missing: string[];
  /** Absolute skills root that was checked. */
  skillsRoot: string;
}

interface ValidateOptions {
  /** Override the skills root (default: env HERMES_SKILLS_DIR or /data/hermes/skills). */
  skillsRoot?: string;
  /** Override fs.stat (test seam). */
  statImpl?: (p: string) => Promise<{ isFile(): boolean }>;
  /** Override env reader (test seam). */
  envImpl?: Record<string, string | undefined>;
}

/**
 * Validate that every Hermes skill referenced in `config.hermes_skill`
 * (single path) and `config.hermes_skills` (array of paths) exists on
 * disk. Returns a structured result; never throws.
 */
export async function validateAgentSkills(
  config: Record<string, unknown>,
  options: ValidateOptions = {},
): Promise<SkillValidationResult> {
  const env = options.envImpl ?? process.env;
  const envSkillsRoot =
    typeof env.HERMES_SKILLS_DIR === "string" && env.HERMES_SKILLS_DIR.trim().length > 0
      ? env.HERMES_SKILLS_DIR.trim()
      : null;
  const skillsRoot = options.skillsRoot ?? envSkillsRoot ?? DEFAULT_SKILLS_ROOT;
  const stat = options.statImpl ?? ((p: string) => fs.stat(p));

  const declaredRaw: string[] = [];
  if (typeof config.hermes_skill === "string" && config.hermes_skill.trim().length > 0) {
    declaredRaw.push(config.hermes_skill.trim());
  }
  if (Array.isArray(config.hermes_skills)) {
    for (const entry of config.hermes_skills) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        declaredRaw.push(entry.trim());
      }
    }
  }
  const declared = Array.from(new Set(declaredRaw));

  const found: string[] = [];
  const missing: string[] = [];

  for (const ref of declared) {
    const resolved = path.isAbsolute(ref) ? ref : path.join(skillsRoot, ref);
    try {
      const stats = await stat(resolved);
      if (stats.isFile()) {
        found.push(ref);
      } else {
        missing.push(ref);
      }
    } catch {
      missing.push(ref);
    }
  }

  return {
    declared: declared.length,
    found,
    missing,
    skillsRoot,
  };
}

/**
 * Resolve a declared skill reference to its absolute path on disk for
 * logging purposes (mirrors the resolution `validateAgentSkills` performs).
 */
export function resolveSkillPath(ref: string, skillsRoot: string): string {
  return path.isAbsolute(ref) ? ref : path.join(skillsRoot, ref);
}
