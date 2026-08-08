/**
 * The eject path, exercised through the real binary: `export --jsonl` and
 * `import` are the hedge against the schema, so they are tested end to end
 * rather than against the store's internals.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(db: string, args: string[]): Run {
  const result = Bun.spawnSync(["bun", MAIN, ...args], {
    env: { ...process.env, AGENTBOARD_DB: db },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function envelope(result: Run): { ok: boolean; error: { code: string } | null; data: any } {
  return JSON.parse(result.stdout.trim());
}

describe("the CLI contract", () => {
  test("a full board survives export and import unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentboard-roundtrip-"));
    try {
      const source = join(directory, "source.sqlite3");
      const target = join(directory, "target.sqlite3");
      const file = join(directory, "board.jsonl");

      run(source, [
        "add",
        "the",
        "auth",
        "cleanup",
        "--tag",
        "auth,security",
        "--summary",
        "rotate",
      ]);
      run(source, ["add", "the", "log", "panel"]);
      run(source, ["add", "the", "icons"]);
      run(source, ["relate", "the log panel", "depends-on", "the auth cleanup"]);
      run(source, ["link", "the log panel", "--wiki", "logging", "--rel", "spec"]);
      run(source, ["claim", "the auth cleanup", "--agent", "codex"]);
      run(source, ["rm", "the icons", "--reason", "not now"]);
      const exported = run(source, ["export", "--out", file]);
      expect(exported.code).toBe(0);

      const imported = run(target, ["import", file]);
      expect(imported.code).toBe(0);

      const strip = (text: string) =>
        text
          .split("\n")
          .filter((line) => line.length > 0 && !line.includes('"meta"'))
          .sort()
          .join("\n");
      expect(strip(run(target, ["export"]).stdout)).toBe(strip(run(source, ["export"]).stdout));

      // The tombstone survives as a tombstone, with the rank it held.
      const listed = envelope(run(target, ["list", "--json"]));
      expect(listed.data.items).toHaveLength(2);
      const removed = envelope(run(target, ["get", "the icons", "--json"]));
      expect(removed.data.deleted_at).not.toBeNull();
      expect(removed.data.rank).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("import refuses a board that already holds a history", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentboard-roundtrip-"));
    try {
      const db = join(directory, "board.sqlite3");
      const file = join(directory, "board.jsonl");
      run(db, ["add", "a thing"]);
      run(db, ["export", "--out", file]);
      const refused = run(db, ["import", file, "--json"]);
      expect(refused.code).toBe(1);
      expect(envelope(refused).error?.code).toBe("board_not_empty");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a usage fault prints help on stderr and is never an envelope", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentboard-roundtrip-"));
    try {
      const db = join(directory, "board.sqlite3");
      const fault = run(db, ["claim", "nothing", "--json"]);
      expect(fault.code).toBe(2);
      expect(fault.stdout).toBe("");
      expect(fault.stderr).toMatch(/--agent is required/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a domain failure is an ok:false envelope on stdout with exit 1", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentboard-roundtrip-"));
    try {
      const db = join(directory, "board.sqlite3");
      run(db, ["add", "the auth cleanup"]);
      const refused = run(db, ["add", "Auth", "cleanup", "--json"]);
      expect(refused.code).toBe(1);
      const body = envelope(refused);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("existing_topic");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The headline property: several agents reading `ready` at once and racing
  // for the same item must produce exactly one holder, not two.
  test("only one of several agents racing for the same item wins the claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentboard-race-"));
    try {
      const db = join(directory, "board.sqlite3");
      run(db, ["add", "the contested item"]);
      const racers = Array.from({ length: 8 }, (_, index) =>
        Bun.spawn(
          ["bun", MAIN, "claim", "the contested item", "--agent", `agent-${index}`, "--json"],
          {
            env: { ...process.env, AGENTBOARD_DB: db },
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      );
      const codes = await Promise.all(racers.map((racer) => racer.exited));
      expect(codes.filter((code) => code === 0)).toHaveLength(1);
      const item = envelope(run(db, ["get", "the contested item", "--json"])).data;
      expect(item.state).toBe("active");
      expect(item.claim.agent).toMatch(/^agent-\d$/);
      // The losers were refused, not queued behind the winner.
      const events = envelope(run(db, ["events", "the contested item", "--json"])).data.events;
      expect(events.filter((event: { kind: string }) => event.kind === "claimed")).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a board written by a newer agentboard is refused loudly", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentboard-roundtrip-"));
    try {
      const db = join(directory, "board.sqlite3");
      run(db, ["add", "a thing"]);
      const { Database } = require("bun:sqlite");
      const handle = new Database(db);
      handle.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
      handle.close();
      const refused = run(db, ["list", "--json"]);
      expect(refused.code).toBe(1);
      expect(envelope(refused).error?.code).toBe("unsupported_schema_version");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
