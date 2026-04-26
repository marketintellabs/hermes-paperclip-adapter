#!/usr/bin/env node
/**
 * paperclip-hermes-health — runtime health probe.
 *
 * Print structured JSON describing the readiness of the surroundings
 * a Hermes Agent run will see: hermes binary in PATH, $HERMES_HOME
 * mounted and writable, state.db readable, OpenRouter reachable.
 *
 * Intended audiences:
 *
 *   1. Operators — `kubectl exec`, ECS exec, or local `npx` to surface
 *      a quick "what's broken right now" snapshot before paging.
 *   2. Agents — the Staff Engineer agent (or any agent with shell
 *      access) can call this directly and parse the JSON instead of
 *      issuing ad-hoc diagnostic commands. Output is stable across
 *      releases; check codes are guaranteed not to change without a
 *      major-version bump.
 *
 * Exit codes:
 *
 *   0 — pass (every check returned info-level)
 *   1 — fail (at least one error-level check)
 *   2 — warn (no errors, at least one warn-level check; the call
 *       still succeeded, but a non-foundational concern was found —
 *       e.g. OpenRouter degraded)
 *
 * Flags:
 *
 *   --no-network         Skip the OpenRouter reachability probe.
 *   --hermes-home <path> Override $HERMES_HOME for this probe.
 *   --hermes-cmd <name>  Override the binary name to invoke.
 *   --pretty             Indent the JSON output (default: dense).
 */

import { runHealthCheck } from "../server/health-check.js";

interface ParsedArgs {
  skipNetwork: boolean;
  hermesHome: string | undefined;
  hermesCommand: string | undefined;
  pretty: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    skipNetwork: false,
    hermesHome: undefined,
    hermesCommand: undefined,
    pretty: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--no-network":
        out.skipNetwork = true;
        break;
      case "--pretty":
        out.pretty = true;
        break;
      case "--hermes-home":
        out.hermesHome = argv[++i];
        break;
      case "--hermes-cmd":
        out.hermesCommand = argv[++i];
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "paperclip-hermes-health — runtime readiness probe for the Hermes adapter.",
            "",
            "Usage:",
            "  paperclip-hermes-health [--no-network] [--pretty]",
            "                          [--hermes-home <path>] [--hermes-cmd <name>]",
            "",
            "Exit codes: 0=pass, 1=fail, 2=warn.",
            "",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`paperclip-hermes-health: unknown flag: ${arg}\n`);
        process.exit(64);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runHealthCheck({
    skipNetwork: args.skipNetwork,
    hermesHome: args.hermesHome,
    hermesCommand: args.hermesCommand,
  });
  process.stdout.write(
    args.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result),
  );
  process.stdout.write("\n");
  if (result.status === "fail") process.exit(1);
  if (result.status === "warn") process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `paperclip-hermes-health: fatal: ${(err as Error)?.stack ?? String(err)}\n`,
  );
  process.exit(70);
});
