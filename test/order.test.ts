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

  test("next lands behind the item currently leading the board", () => {
    expect(move(["d"], { at: "next" })).toEqual(["a", "d", "b", "c"]);
  });

  test("next is the front when the leader is itself being moved", () => {
    expect(move(["a", "d"], { at: "next" })).toEqual(["b", "a", "d", "c"]);
  });

  test("next skips finished and removed work when looking for the leader", () => {
    const board = [
      row("done", "done"),
      row("gone", "open", "2026-01-01T00:00:00Z"),
      row("a"),
      row("b"),
    ];
    expect(move(["b"], { at: "next" }, board)).toEqual(["done", "gone", "a", "b"]);
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
