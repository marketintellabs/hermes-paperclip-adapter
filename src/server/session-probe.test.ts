import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  sessionExistsInHermesDb,
  resolveRealHermesHome,
} from "./session-probe.js";

function freshTempHome(): string {
  return mkdtempSync(join(tmpdir(), "hermes-probe-test-"));
}

function seedStateDb(homePath: string, sessionIds: string[]): void {
  const db = new DatabaseSync(join(homePath, "state.db"));
  // Minimal schema — the probe only reads `id`, and an empty row
  // doesn't interact with Hermes' other tables. Keeping the schema
  // narrow here keeps tests resilient to upstream Hermes schema
  // additions (new columns → our SELECT doesn't care).
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  const stmt = db.prepare("INSERT INTO sessions (id) VALUES (?)");
  for (const id of sessionIds) stmt.run(id);
  db.close();
}

describe("resolveRealHermesHome", () => {
  it("prefers explicit HERMES_HOME", () => {
    const home = resolveRealHermesHome({ HERMES_HOME: "/custom/home" } as NodeJS.ProcessEnv);
    assert.equal(home, "/custom/home");
  });

  it("falls back to $HOME/.hermes when HERMES_HOME is unset", () => {
    const home = resolveRealHermesHome({ HOME: "/tmp/fake-home" } as NodeJS.ProcessEnv);
    assert.equal(home, "/tmp/fake-home/.hermes");
  });

  it("falls back to os.homedir()/.hermes when HOME is also unset", () => {
    const home = resolveRealHermesHome({} as NodeJS.ProcessEnv);
    assert.ok(home.endsWith("/.hermes"), `expected ~/.hermes suffix, got ${home}`);
  });
});

describe("sessionExistsInHermesDb", () => {
  it("returns exists=null when state.db is missing (fail-open)", () => {
    const homeDir = freshTempHome();
    try {
      const r = sessionExistsInHermesDb("20260419_222221_c19d0c", homeDir);
      assert.equal(r.exists, null);
      assert.equal(r.source, "probe-failed");
      assert.match((r as { reason: string }).reason, /state\.db missing/);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns exists=true for an id present in the sessions table", () => {
    const homeDir = freshTempHome();
    try {
      seedStateDb(homeDir, ["20260419_222221_c19d0c", "another_session_id_ok"]);
      const r = sessionExistsInHermesDb("20260419_222221_c19d0c", homeDir);
      assert.equal(r.exists, true);
      assert.equal(r.source, "state.db");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns exists=false for an id missing from an otherwise-populated db (A.1 case)", () => {
    // This is the 0.8.5 regression case: state.db exists, other
    // sessions exist, but the requested id was wiped.
    const homeDir = freshTempHome();
    try {
      seedStateDb(homeDir, ["some_other_session_that_exists_2026"]);
      const r = sessionExistsInHermesDb("20260419_222221_c19d0c", homeDir);
      assert.equal(r.exists, false);
      assert.equal(r.source, "state.db");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns exists=null when state.db has no sessions table (fail-open, schema drift)", () => {
    const homeDir = freshTempHome();
    try {
      const db = new DatabaseSync(join(homeDir, "state.db"));
      db.exec("CREATE TABLE unrelated (x INTEGER)");
      db.close();
      const r = sessionExistsInHermesDb("20260419_222221_c19d0c", homeDir);
      assert.equal(r.exists, null, "probe must fail open when schema is unexpected");
      assert.equal(r.source, "probe-failed");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("returns exists=null when state.db is garbage bytes (fail-open, corrupt db)", () => {
    const homeDir = freshTempHome();
    try {
      writeFileSync(join(homeDir, "state.db"), "not-a-real-sqlite-file");
      const r = sessionExistsInHermesDb("20260419_222221_c19d0c", homeDir);
      assert.equal(r.exists, null);
      assert.equal(r.source, "probe-failed");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not throw on any input — all errors become exists=null", () => {
    // Probing a path that can't exist (contains NUL in practice fails
    // noisily but existsSync returns false cleanly). Ensure the top-level
    // function never throws regardless.
    assert.doesNotThrow(() => {
      sessionExistsInHermesDb("id", "/nonexistent/dir/does/not/exist");
    });
  });
});
