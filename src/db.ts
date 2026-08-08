/**
 * Opening the board. One connection, one migration ladder, and one rule about
 * versions: a database written by a newer agentboard is refused loudly rather
 * than opened hopefully.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CliError } from "./errors.ts";
import { dataDirectory, type Environ, expandTilde } from "./paths.ts";
import { BOARD_SCHEMA_VERSION, SCHEMA_V1 } from "./schema.ts";

export const DEFAULT_DATABASE_FILE = "board.sqlite3";

/** `--db` outranks the environment, which outranks the XDG data directory. */
export function resolveDatabasePath(flag: string | undefined, env: Environ, home: string): string {
  const chosen = flag ?? env["AGENTBOARD_DB"];
  if (chosen !== undefined && chosen.trim().length > 0) {
    const expanded = expandTilde(chosen.trim(), home);
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(dataDirectory(env, home, "agentboard"), DEFAULT_DATABASE_FILE);
}

function storedVersion(db: Database): number | null {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1")
    .get();
  if (table === null) return null;
  const row = db.query("SELECT value FROM meta WHERE key='schema_version'").get() as {
    value: string;
  } | null;
  if (row === null) return null;
  const version = Number(row.value);
  if (!Number.isInteger(version)) {
    throw new CliError("bad_schema_version", "the board's schema_version is not an integer");
  }
  return version;
}

function assertSupported(version: number): void {
  if (version > BOARD_SCHEMA_VERSION) {
    throw new CliError(
      "unsupported_schema_version",
      `this board is at schema version ${version}, and this agentboard understands ${BOARD_SCHEMA_VERSION}`,
      "upgrade agentboard; an older build must not migrate a newer board backwards",
    );
  }
}

export function openBoard(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  try {
    const existing = storedVersion(db);
    if (existing !== null) assertSupported(existing);
    try {
      const journal = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      if (journal.journal_mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode=WAL;");
    } catch {
      // WAL is unavailable on some filesystems; transactions still hold without it.
    }
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: Database): void {
  const current = storedVersion(db);
  if (current === BOARD_SCHEMA_VERSION) return;
  db.transaction(() => {
    const version = storedVersion(db);
    if (version === null) {
      db.exec(SCHEMA_V1);
      return;
    }
    assertSupported(version);
    // Later versions add their step here; each one is forward-only and runs
    // inside this same transaction, so a half-migrated board is not reachable.
  }).immediate();
}
