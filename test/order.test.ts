import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors.ts";
import { type Placement, placeItems } from "../src/order.ts";
import type { ItemState } from "../src/types.ts";

interface Row {
  id: string;
  label: string;
  state: ItemState;
  deletedAt: string | null;
}

const row = (id: string, state: ItemState = "open", deletedAt: string | null = null): Row => ({
  id,
  label: id,
  state,
  deletedAt,
});

const sequence = [row("a"), row("b"), row("c"), row("d")];
const move = (ids: string[], placement: Placement, from: Row[] = sequence): string[] =>
  placeItems(from, ids, placement).map((item) => item.id);

describe("placeItems", () => {
  test("first and last are the ends of the whole sequence", () => {
    expect(move(["c"], { at: "first" })).toEqual(["c", "a", "b", "d"]);
    expect(move(["a"], { at: "last" })).toEqual(["b", "c", "d", "a"]);
  });

  test("keeps the dictated sequence exactly", () => {
    expect(move(["d", "b"], { at: "first" })).toEqual(["d", "b", "a", "c"]);
  });

  test("next is the front when nothing is underway", () => {
    expect(move(["d"], { at: "next" })).toEqual(["d", "a", "b", "c"]);
    expect(move(["d"], { at: "next" })).toEqual(move(["d"], { at: "first" }));
  });

  test("next lands behind the one item being worked", () => {
    const board = [row("running", "active"), row("a"), row("b")];
    expect(move(["b"], { at: "next" }, board)).toEqual(["running", "b", "a"]);
  });

  // The case the whole shape exists for: taking the *first* busy item would put
  // the moved run at index 1, ahead of the second agent's work.
  test("two agents working: next stays behind both, not just the first", () => {
    const board = [
      row("alice-is-on-this", "active"),
      row("idle-between"),
      row("bob-is-on-this", "active"),
      row("a"),
      row("b"),
    ];
    expect(move(["b"], { at: "next" }, board)).toEqual([
      "alice-is-on-this",
      "idle-between",
      "bob-is-on-this",
      "b",
      "a",
    ]);
  });

  // Not a prefix length: the idle item sitting between two busy ones is carried
  // along rather than displaced, because nobody asked to reorder it.
  test("an idle item between two busy ones keeps its place", () => {
    const board = [row("busy1", "active"), row("idle"), row("busy2", "active"), row("a")];
    expect(move(["a"], { at: "next" }, board)).toEqual(["busy1", "idle", "busy2", "a"]);
  });

  test("moving every in-flight item collapses next to first", () => {
    const board = [row("busy1", "active"), row("busy2", "active"), row("a"), row("b")];
    expect(move(["busy1", "busy2"], { at: "next" }, board)).toEqual(["busy1", "busy2", "a", "b"]);
    expect(move(["b", "busy1", "busy2"], { at: "next" }, board)).toEqual([
      "b",
      "busy1",
      "busy2",
      "a",
    ]);
  });

  test("a moved in-flight item cannot pin itself to its own former place", () => {
    const board = [row("a"), row("busy", "active"), row("b")];
    expect(move(["busy"], { at: "next" }, board)).toEqual(["busy", "a", "b"]);
  });

  test("finished, waiting, paused, and removed work is not in flight", () => {
    for (const state of ["done", "waiting", "paused"] as ItemState[]) {
      const board = [row("not-underway", state), row("a")];
      expect(move(["a"], { at: "next" }, board)).toEqual(["a", "not-underway"]);
    }
    const removed = [row("gone", "active", "2026-01-01T00:00:00Z"), row("a")];
    expect(move(["a"], { at: "next" }, removed)).toEqual(["a", "gone"]);
  });

  test("after means after the anchor once the movers are lifted out", () => {
    // "after c" must not shift by the mover that sat above c.
    expect(move(["a"], { at: "after", anchor: "c" })).toEqual(["b", "c", "a", "d"]);
    expect(move(["a", "b"], { at: "after", anchor: "c" })).toEqual(["c", "a", "b", "d"]);
  });

  test("the result is always a permutation of the input", () => {
    for (const placement of [
      { at: "first" },
      { at: "next" },
      { at: "last" },
      { at: "after", anchor: "b" },
    ] as Placement[]) {
      const result = move(["d", "a"], placement);
      expect([...result].sort()).toEqual(["a", "b", "c", "d"]);
    }
  });

  test("refuses a batch that names an item twice, a stranger, or its own anchor", () => {
    expect(() => move(["a", "a"], { at: "first" })).toThrow(CliError);
    expect(() => move(["zz"], { at: "first" })).toThrow(/unknown item to move/);
    expect(() => move(["a"], { at: "after", anchor: "a" })).toThrow(/relative to itself/);
    expect(() => placeItems(sequence, [], { at: "first" })).toThrow(/at least one item/);
  });

  test("refuses to move or anchor against a removed item", () => {
    const board = [row("a"), row("gone", "open", "2026-01-01T00:00:00Z")];
    expect(() => move(["gone"], { at: "first" }, board)).toThrow(/removed from the board/);
    expect(() => move(["a"], { at: "after", anchor: "gone" }, board)).toThrow(
      /removed from the board/,
    );
  });
});
