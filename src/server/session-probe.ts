/**
 * Pre-spawn session-existence probe for `hermes chat --resume <id>`.
 *
 * Context (what problem this solves):
 *
 * Hermes persists sessions in a SQLite database at `$HERMES_HOME/state.db`
 * in a table called `sessions` keyed on a TEXT `id` column. When the
 * adapter spawns `hermes chat --resume <id>`, Hermes looks the id up
 * in that table; if it's missing, it exits with
 * `Session not found: <id>\nUse a session ID from a previous CLI run.`
 * and a non-zero exit code. From the adapter's perspective this
 * presents as a generic `adapter_failed` run with no telemetry.
 *
 * The 0.8.3 resume guard (see `resolveResumeSessionId`) catches session
 * ids whose *shape* is wrong ("from", "run", etc.) — the classic
 * regex-false-positive case. But it does nothing for session ids that
 * ARE shaped correctly (e.g. `20260419_222221_c19d0c`) but no longer
 * exist on disk. That can happen when:
 *
 *   - Paperclip's `agent_task_sessions.session_params_json.sessionId`
 *     records a session that was later wiped from state.db by:
 *       * a container restart (paperclip's `~/.hermes` is on the
 *         container filesystem, not EFS — rebuilds wipe it).
 *       * a Hermes-side session TTL / manual prune.
 *       * an ops-initiated state.db reset.
 *   - An agent is cloned from another agent's config, inheriting its
 *     stored session id.
 *
 * Without this probe the same missing id gets replayed on every
 * heartbeat, producing an indefinite `adapter_failed` loop.
 *
 * Fail-open policy:
 *
 * If the probe itself fails (no state.db, schema mismatch, permission
 * error, anything that isn't a definite "id not in the sessions
 * table"), we return `null` and let the resume proceed. Hermes's own
 * lookup is the source of truth — we'd rather occasionally let a
 * broken resume through than block every resume whenever the probe
 * has a glitch.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export type SessionProbeResult =
  | { exists: true; source: "state.db" }
  | { exists: false; source: "state.db" | "no-state-db" }
  | { exists: null; source: "probe-failed"; reason: string };

/**
 * Resolve the HERMES_HOME for session lookup. Mirrors the resolution
 * in `buildPerRunHermesHome` so the probe always inspects the SAME
 * state.db that the spawned `hermes chat` process will consult.
 *
 * The per-run HERMES_HOME temp dir built by `buildPerRunHermesHome`
 * does NOT yet exist at probe time (we probe before the dir is built),
 * but that dir is just a symlink farm over the real home — `state.db`
 * only exists in the real home, so we look there directly.
 */
export function resolveRealHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_HOME || join(env.HOME || homedir(), ".hermes");
}

/**
 * Check whether a session id exists in Hermes' `state.db`.
 *
 * Intended to be called BEFORE spawning `hermes chat --resume <id>`.
 * Returns:
 *
 *   { exists: true  } — session id is in the `sessions` table, safe to resume
 *   { exists: false } — state.db opened cleanly, id is not there → reject
 *   { exists: null  } — probe could not complete (no db file, schema
 *                       mismatch, IO error, native SQLite missing) →
 *                       fail open, let the resume proceed
 *
 * All errors are caught internally; this function never throws.
 */
export function sessionExistsInHermesDb(
  sessionId: string,
  hermesHome: string = resolveRealHermesHome(),
): SessionProbeResult {
  const dbPath = join(hermesHome, "state.db");

  // A missing state.db is NOT an inconclusive probe failure — Hermes
  // lazily creates state.db on its first write, so if the file doesn't
  // exist then Hermes has never persisted any sessions on this host
  // and the requested id CANNOT be present. Treat as a definitive
  // "not found" so we strip --resume and let Hermes create a fresh
  // session instead of crashing with "Session not found".
  //
  // This is the exact failure mode that manifested right after the
  // 0.8.5 container rollout wiped the ephemeral ~/.hermes: state.db
  // didn't exist yet, 0.8.5 failed open, `hermes chat --resume <id>`
  // ran anyway, and `Session not found: <id>` took down the heartbeat.
  // 0.8.6 closes that window by treating "no state.db" as "no
  // sessions".
  if (!existsSync(dbPath)) {
    return { exists: false, source: "no-state-db" };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare("SELECT 1 AS present FROM sessions WHERE id = ? LIMIT 1");
    const row = stmt.get(sessionId) as { present?: number } | undefined;
    return row?.present === 1
      ? { exists: true, source: "state.db" }
      : { exists: false, source: "state.db" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exists: null, source: "probe-failed", reason: message };
  } finally {
    try {
      db?.close();
    } catch {
      // swallow — the db will be GC'd, no fd leak matters for a one-shot probe.
    }
  }
}
