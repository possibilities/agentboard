import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBoard } from "../src/db.ts";
import { Board } from "../src/store.ts";
import type { Item, ItemState } from "../src/types.ts";

/** Every test gets its own database under a temp directory and nothing else. */
export function withBoard<T>(body: (board: Board, directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "agentboard-test-"));
  const board = new Board(openBoard(join(directory, "board.sqlite3")));
  try {
    return body(board, directory);
  } finally {
    board.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A stand-in item for the pure modules, which never see a database. */
export function fakeItem(overrides: Partial<Item> & { id: string; label: string }): Item {
  return {
    title: overrides.label,
    topicKey: overrides.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    summary: null,
    tags: [],
    state: "open" as ItemState,
    stateReason: null,
    origin: "human",
    rank: 0,
    claim: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    deletedReason: null,
    revision: 1,
    ...overrides,
  };
}

/** Deterministic pseudo-randomness: a failing property must be reproducible. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
