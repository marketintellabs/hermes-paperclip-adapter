import { z } from "zod";

/**
 * Priority values the Paperclip Issues API accepts on
 * `POST /companies/:id/issues`. The API validates this field as a string
 * enum and rejects anything else with HTTP 400
 * (`"Expected 'critical' | 'high' | 'medium' | 'low', received number"`).
 */
export const PAPERCLIP_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type PaperclipPriority = (typeof PAPERCLIP_PRIORITIES)[number];

/**
 * Coerce any LLM-supplied priority into the enum string the Paperclip
 * Issues API requires, or `undefined` to omit it (the board defaults new
 * issues to "medium").
 *
 * This NEVER throws. That property is the whole point: priority is the
 * single most failure-prone delegation argument we have. The pre-fix MCP
 * schema advertised `z.number().int().min(0).max(4)`, so:
 *
 *   - an LLM that passes the API's own enum string ("high") was rejected
 *     by the MCP SDK's pre-execute schema validation, and
 *   - an LLM that obeyed the schema and passed an integer (2) had it
 *     forwarded verbatim and rejected by the API with HTTP 400.
 *
 * Either way the model saw a `fix-args` rejection with no actionable
 * detail and burned its tool-call budget cycling through values — the
 * chronic `create_sub_issue` retry-loop → 600s-timeout failure (tracked
 * as F6 in docs/ADAPTER_REDESIGN.md). Coercing instead of validating
 * removes the failure mode at the source: any reasonable input maps to a
 * valid enum, and anything unrecognised is dropped rather than rejected.
 *
 * Accepts:
 *   - the API enum strings ("critical" | "high" | "medium" | "low")
 *   - common synonyms ("urgent"/"p0" → critical, "med"/"normal" → medium)
 *   - legacy integers / numeric strings on the 0..4 scale the old schema
 *     advertised (0 = none → omit, 1 = urgent → critical, 2 = high,
 *     3 = medium, 4 = low)
 */
export function coercePriority(raw: unknown): PaperclipPriority | undefined {
  if (raw === undefined || raw === null) return undefined;

  // Numeric scale (number or all-digit string): the legacy 0..4 scale the
  // pre-fix schema described to the model.
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : undefined;
  if (n !== undefined) {
    switch (n) {
      case 1:
        return "critical"; // legacy "urgent"
      case 2:
        return "high";
      case 3:
        return "medium";
      case 4:
        return "low";
      default:
        // 0 = "no priority" and anything out of range → omit and let the
        // API default. Never reject.
        return undefined;
    }
  }

  if (typeof raw === "string") {
    switch (raw.trim().toLowerCase()) {
      case "critical":
      case "urgent":
      case "p0":
        return "critical";
      case "high":
      case "p1":
        return "high";
      case "medium":
      case "med":
      case "normal":
      case "p2":
        return "medium";
      case "low":
      case "p3":
        return "low";
      default:
        return undefined;
    }
  }

  return undefined;
}

/**
 * Tolerant, optional MCP input field for priority.
 *
 * Accepts `string | number` (so the SDK's pre-execute `safeParseAsync`
 * can NEVER reject on a priority type mismatch) and is `.optional()` so
 * omitting it is fine. The actual normalisation to the API enum happens
 * in each tool's `execute` via {@link coercePriority} — keeping the
 * schema's only job "don't reject" and the mapping logic in one
 * unit-tested place. The description steers the model toward the
 * canonical enum values.
 */
export const prioritySchema = z
  .union([z.string(), z.number()])
  .optional()
  .describe(
    "Optional. One of 'critical' | 'high' | 'medium' | 'low'. Legacy " +
      "integers (1=critical, 2=high, 3=medium, 4=low) and synonyms " +
      "(urgent→critical) are accepted and normalized; unrecognised values " +
      "are ignored (new issues default to medium). Omitting it is fine.",
  );
