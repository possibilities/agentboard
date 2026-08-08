import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors.ts";
import {
  assertAcyclic,
  blockersOf,
  canonicalEdge,
  containsForest,
  type Edge,
  edgeKey,
  findCycle,
  readyItems,
} from "../src/graph.ts";
import type { ItemState } from "../src/types.ts";
import { fakeItem } from "./helpers.ts";

const edge = (kind: Edge["kind"], from: string, to: string): Edge => ({ kind, from, to });

describe("canonical edges", () => {
  test("symmetric kinds read the same either way", () => {
    expect(edgeKey(edge("related-to", "b", "a"))).toBe(edgeKey(edge("related-to", "a", "b")));
    expect(edgeKey(edge("conflicts-with", "z", "a"))).toBe(
      edgeKey(edge("conflicts-with", "a", "z")),
    );
  });

  test("directed kinds keep their direction", () => {
    expect(edgeKey(edge("depends-on", "b", "a"))).not.toBe(edgeKey(edge("depends-on", "a", "b")));
    expect(canonicalEdge(edge("contains", "b", "a"))).toEqual(edge("contains", "b", "a"));
  });
});

describe("findCycle", () => {
  test("finds a direct loop and a long one", () => {
    expect(findCycle([edge("contains", "a", "b"), edge("contains", "b", "a")], "contains")).toEqual(
      ["a", "b", "a"],
    );
    const long = [
      edge("depends-on", "a", "b"),
      edge("depends-on", "b", "c"),
      edge("depends-on", "c", "a"),
    ];
    expect(findCycle(long, "depends-on")).not.toBeNull();
  });

  test("a diamond is not a cycle", () => {
    const diamond = [
      edge("contains", "a", "b"),
      edge("contains", "a", "c"),
      edge("contains", "b", "d"),
      edge("contains", "c", "d"),
    ];
    expect(findCycle(diamond, "contains")).toBeNull();
  });

  test("a loop that only exists across kinds is allowed", () => {
    const mixed = [edge("contains", "a", "b"), edge("depends-on", "b", "a")];
    expect(() => assertAcyclic(mixed, (id) => id)).not.toThrow();
  });

  test("assertAcyclic names the loop it refuses", () => {
    expect(() =>
      assertAcyclic([edge("contains", "a", "b"), edge("contains", "b", "a")], (id) => id),
    ).toThrow(CliError);
  });

  test("survives a deep chain without overflowing", () => {
    const deep: Edge[] = [];
    for (let index = 0; index < 20_000; index++)
      deep.push(edge("contains", `n${index}`, `n${index + 1}`));
    expect(findCycle(deep, "contains")).toBeNull();
  });
});

describe("readyItems", () => {
  const items = (states: Record<string, ItemState>) =>
    Object.entries(states).map(([id, state], rank) => fakeItem({ id, label: id, state, rank }));

  test("open work with no blockers is ready, in board order", () => {
    const board = items({ a: "open", b: "open" });
    expect(readyItems(board, []).map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("an unfinished blocker holds an item back", () => {
    const board = items({ a: "open", b: "open" });
    expect(readyItems(board, [edge("depends-on", "a", "b")]).map((item) => item.id)).toEqual(["b"]);
  });

  test("a finished blocker stops blocking", () => {
    const board = items({ a: "open", b: "done" });
    expect(readyItems(board, [edge("depends-on", "a", "b")]).map((item) => item.id)).toEqual(["a"]);
  });

  test("a removed blocker stops blocking", () => {
    const board = [
      fakeItem({ id: "a", label: "a", state: "open" }),
      fakeItem({ id: "b", label: "b", state: "open", deletedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(readyItems(board, [edge("depends-on", "a", "b")]).map((item) => item.id)).toEqual(["a"]);
  });

  test("claimed, waiting, and paused work is never ready", () => {
    const board = items({ a: "active", b: "waiting", c: "paused", d: "done" });
    expect(readyItems(board, [])).toEqual([]);
  });

  test("blockersOf explains exactly why", () => {
    const board = items({ a: "open", b: "open", c: "done" });
    const blockers = blockersOf("a", board, [
      edge("depends-on", "a", "b"),
      edge("depends-on", "a", "c"),
    ]);
    expect(blockers.map((item) => item.id)).toEqual(["b"]);
  });
});

describe("containsForest", () => {
  test("items contained by nothing are the roots", () => {
    const board = ["a", "b", "c"].map((id) => fakeItem({ id, label: id }));
    const forest = containsForest(board, [edge("contains", "a", "b")]);
    expect(forest.map((node) => node.item.id)).toEqual(["a", "c"]);
    expect(forest[0]!.children.map((node) => node.item.id)).toEqual(["b"]);
  });

  test("a root argument narrows the forest to one tree", () => {
    const board = ["a", "b", "c"].map((id) => fakeItem({ id, label: id }));
    const forest = containsForest(board, [edge("contains", "a", "b")], "a");
    expect(forest).toHaveLength(1);
    expect(forest[0]!.item.id).toBe("a");
  });

  test("a cycle in imported data terminates rather than recursing forever", () => {
    const board = ["a", "b"].map((id) => fakeItem({ id, label: id }));
    const forest = containsForest(
      board,
      [edge("contains", "a", "b"), edge("contains", "b", "a")],
      "a",
    );
    expect(forest[0]!.children[0]!.children).toEqual([]);
  });
});
