/**
 * `guide` is listed read_only in the card it prints, and it only names the
 * database path — so running it must not be the reason a database exists.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

test("guide does not bring a database into existence", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentboard-boardless-"));
  try {
    const db = join(directory, "absent", "board.sqlite3");
    const result = Bun.spawnSync(["bun", MAIN, "guide", "--db", db, "--json"], {
      env: { ...process.env, HOME: directory, AGENTBOARD_DB: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(new TextDecoder().decode(result.stdout).trim());
    expect(envelope.ok).toBe(true);
    // It still reports the path it would have used — that is the card's job.
    expect(envelope.data.db_path).toBe(db);

    expect(existsSync(db)).toBe(false);
    expect(existsSync(join(directory, "absent"))).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
