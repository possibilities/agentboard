/**
 * An ejected file is hand-editable, so `import` is the boundary where a typo
 * has to be refused rather than seated: the columns are STRICT but TEXT.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

interface Run {
  code: number;
  envelope: {
    ok: boolean;
    error: { code: string; message: string; recovery?: string } | null;
    data: any;
  };
}

function importInto(directory: string, lines: string[]): Run {
  const file = join(directory, "eject.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  const result = Bun.spawnSync(["bun", MAIN, "import", file, "--json"], {
    env: { ...process.env, AGENTBOARD_DB: join(directory, `board-${lines.length}.sqlite3`) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? -1,
    envelope: JSON.parse(new TextDecoder().decode(result.stdout).trim()),
  };
}

function item(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "item",
    id: "it-00000001",
    label: "the auth cleanup",
    title: "The auth cleanup",
    topic_key: "authcleanup",
    summary: null,
    tags: [],
    state: "open",
    state_reason: null,
    origin: "human",
    rank: 0,
    claim: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    deleted_reason: null,
    revision: 1,
    ...overrides,
  });
}

describe("import refuses a corrupted enum", () => {
  const corrupted: Array<[name: string, lines: string[], mentions: string]> = [
    ["a misspelled item state", [item({ state: "blocked" })], "item state"],
    ["an item state that is empty", [item({ state: "" })], "item state"],
    ["an item state that is not a string", [item({ state: 3 })], "item state"],
    ["an unknown origin", [item({ origin: "robot" })], "item origin"],
    [
      "an unknown relation kind",
      [
        item(),
        JSON.stringify({
          type: "relation",
          from: "it-00000001",
          to: "it-00000001",
          kind: "blocks",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      "relation kind",
    ],
    [
      "an unknown ref rel",
      [
        item(),
        JSON.stringify({
          type: "ref",
          itemId: "it-00000001",
          target: "wiki:logging",
          rel: "seealso",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      "ref rel",
    ],
  ];

  for (const [name, lines, mentions] of corrupted) {
    test(name, () => {
      const directory = mkdtempSync(join(tmpdir(), "agentboard-import-"));
      try {
        const run = importInto(directory, lines);
        expect(run.code).toBe(1);
        expect(run.envelope.ok).toBe(false);
        expect(run.envelope.error?.code).toBe("invalid_export_value");
        expect(run.envelope.error?.message).toContain(mentions);
        // A refusal an agent can act on, not just a complaint.
        expect(run.envelope.error?.recovery).toBeDefined();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("import still accepts a well-formed line", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentboard-import-ok-"));
  try {
    const run = importInto(directory, [item()]);
    expect(run.code).toBe(0);
    expect(run.envelope.ok).toBe(true);
    expect(run.envelope.data.items).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
