/**
 * The one order. `rank` is a dense, unique, zero-based sequence over every row
 * on the board; every listing is that sequence, filtered, never re-sorted.
 *
 * A move is a permutation rather than a patch: the movers are lifted out, the
 * remainder is spliced back around them, and the whole result is renumbered.
 * Items therefore cannot be dropped or duplicated by a move, and duplicate
 * ranks are not representable at all.
 */

import { CliError } from "./errors.ts";
import type { ItemState } from "./types.ts";

export const PLACEMENTS = ["first", "next", "last", "after"] as const;

export type Placement =
  | { at: "first" }
  | { at: "next" }
  | { at: "last" }
  | { at: "after"; anchor: string };

/** The order cares about identity, liveness, and finishedness — nothing else. */
export interface Rankable {
  id: string;
  label: string;
  state: ItemState;
  deletedAt: string | null;
}

/**
 * Work that is genuinely underway, and therefore must not be displaced by
 * reprioritizing what comes after it. `active` is exactly that state: claimed
 * and being worked. A waiting or paused item keeps its claim but is not being
 * worked, so it queues like any other idle item — pausing is about attention,
 * not priority, and it must not silently pin the board.
 */
export function isInFlight(item: Rankable): boolean {
  return item.deletedAt === null && item.state === "active";
}

export interface Sortable {
  rank: number;
  createdAt: string;
  id: string;
}

/**
 * Total order over stored ranks. Ties fall through to creation time and then
 * id, so a board assembled from an import or a hand-edited file still has one
 * unambiguous sequence.
 */
export function bySequence(left: Sortable, right: Sortable): number {
  return (
    left.rank - right.rank ||
    (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/**
 * Move items to one place in the sequence, keeping the order they were named.
 *
 * A human who dictates three things to do next says them in an order, and that
 * order is the answer — `ids` is spliced in verbatim. Every id is checked
 * before anything is renumbered, so a batch naming one bad id moves none.
 * Returns the full new sequence; the caller assigns `0..n-1` from it.
 */
export function placeItems<T extends Rankable>(
  sequence: readonly T[],
  ids: readonly string[],
  placement: Placement,
): T[] {
  if (ids.length === 0) {
    throw new CliError("empty_move", "a move needs at least one item to move");
  }
  const duplicate = ids.find((id, at) => ids.indexOf(id) !== at);
  if (duplicate !== undefined) {
    throw new CliError("duplicate_move_id", `a move cannot name the same item twice: ${duplicate}`);
  }
  const byId = new Map(sequence.map((item) => [item.id, item]));
  const moving = ids.map((id) => {
    const item = byId.get(id);
    if (item === undefined) {
      throw new CliError(
        "unknown_ref",
        `unknown item to move: ${id}`,
        "run `agentboard list` to see the board",
      );
    }
    if (item.deletedAt !== null) {
      throw new CliError(
        "removed_item",
        `"${item.label}" was removed from the board and cannot be reordered`,
        `restore it first: agentboard restore ${item.id} --reason "..."`,
      );
    }
    return item;
  });

  const movingIds = new Set(ids);
  // The insertion point is computed against the sequence *without* the movers,
  // so "after X" means after X wherever X ends up once they are lifted out —
  // the alternative silently shifts by however many of them sat above it.
  const remaining = sequence.filter((item) => !movingIds.has(item.id));

  let at: number;
  switch (placement.at) {
    case "first":
      at = 0;
      break;
    case "last":
      at = remaining.length;
      break;
    case "next": {
      // "Next" queues behind *all* the work already underway, not merely the
      // first of it: the insertion point is one past the last in-flight item.
      // This is not a prefix length — in-flight items scattered through the
      // board carry the idle items sitting between them along too, because the
      // alternative is reordering work nobody asked to reorder. Taking the
      // first busy item instead is the bug this shape exists to avoid: with two
      // agents working, it jumps the moved run ahead of the second one.
      //
      // The scan runs over the sequence with the movers already lifted out,
      // which is also what excludes a moved in-flight item structurally — it is
      // not in `remaining`, so it cannot pin itself to its own former place.
      // With nothing in flight, `next` and `first` coincide.
      const last = remaining.reduce(
        (found, item, position) => (isInFlight(item) ? position : found),
        -1,
      );
      at = last + 1;
      break;
    }
    case "after": {
      const anchor = byId.get(placement.anchor);
      if (anchor === undefined) {
        throw new CliError(
          "unknown_ref",
          `unknown item to place against: ${placement.anchor}`,
          "run `agentboard list` to see the board",
        );
      }
      if (movingIds.has(anchor.id)) {
        throw new CliError(
          "self_placement",
          `"${anchor.label}" cannot be placed relative to itself`,
          "name an item that is not part of the move",
        );
      }
      if (anchor.deletedAt !== null) {
        throw new CliError(
          "removed_item",
          `"${anchor.label}" was removed from the board and cannot anchor a move`,
          `restore it first: agentboard restore ${anchor.id} --reason "..."`,
        );
      }
      at = remaining.findIndex((item) => item.id === anchor.id) + 1;
      break;
    }
  }

  return [...remaining.slice(0, at), ...moving, ...remaining.slice(at)];
}

/** The recorded account of one move, in the vocabulary the speaker used. */
export function describePlacement(placement: Placement, labelOf: (id: string) => string): string {
  switch (placement.at) {
    case "first":
      return "moved to the front of the board";
    case "last":
      return "moved to the back of the board";
    case "next":
      return "moved to the front of the board, behind the work already underway";
    case "after":
      return `moved after "${labelOf(placement.anchor)}"`;
  }
}
