import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors.ts";
import { readyItems } from "../src/graph.ts";
import { withBoard } from "./helpers.ts";

const code = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    if (error instanceof CliError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("capture", () => {
  test("a recapture of an open topic is refused, naming the match", () => {
    withBoard((board) => {
      const first = board.addItem({ label: "the auth cleanup" });
      expect(code(() => board.addItem({ label: "Auth cleanup" }))).toBe("existing_topic");
      expect(() => board.addItem({ label: "Auth cleanup" })).toThrow(first.id);
    });
  });

  test("--new captures a second item on the same topic", () => {
    withBoard((board) => {
      board.addItem({ label: "the auth cleanup" });
      const second = board.addItem({ label: "the auth cleanup", allowDuplicateTopic: true });
      expect(second.rank).toBe(1);
    });
  });

  test("a closed topic no longer blocks a recapture", () => {
    withBoard((board) => {
      const first = board.addItem({ label: "the auth cleanup" });
      board.transition(first, "done");
      expect(() => board.addItem({ label: "the auth cleanup" })).not.toThrow();
    });
  });

  test("the title defaults from the label, and capture appends", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "  the   auth cleanup " });
      expect(item.label).toBe("the auth cleanup");
      expect(item.title).toBe("the auth cleanup");
      expect(item.rank).toBe(0);
      expect(board.addItem({ label: "second" }).rank).toBe(1);
    });
  });
});

describe("edit", () => {
  test("a rename recomputes the topic key, so a recapture still finds the item", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the auth cleanup" });
      const edited = board.updateItem(item, { label: "the token rotation" });
      expect(edited.topicKey).toBe("token-rotation");
      // The old topic is free again; the new one is now the one that is taken.
      expect(() => board.addItem({ label: "the auth cleanup" })).not.toThrow();
      expect(code(() => board.addItem({ label: "Token rotation" }))).toBe("existing_topic");
    });
  });

  test("renaming onto a topic another open item holds is refused", () => {
    withBoard((board) => {
      board.addItem({ label: "the auth cleanup" });
      const other = board.addItem({ label: "the log panel" });
      expect(code(() => board.updateItem(other, { label: "Auth cleanup" }))).toBe("existing_topic");
    });
  });

  test("renaming an item to its own topic is not a collision", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the auth cleanup" });
      expect(() => board.updateItem(item, { label: "Auth cleanup" })).not.toThrow();
    });
  });

  test("terminal and removed items refuse an edit", () => {
    withBoard((board) => {
      const done = board.addItem({ label: "finished" });
      board.transition(done, "done");
      expect(code(() => board.updateItem(board.item(done.id)!, { summary: "late" }))).toBe(
        "terminal_item",
      );
      const gone = board.addItem({ label: "removed" });
      board.remove(gone, "not now");
      expect(code(() => board.updateItem(board.item(gone.id)!, { summary: "late" }))).toBe(
        "removed_item",
      );
    });
  });

  test("an edit appends an event and advances the revision", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      const edited = board.updateItem(item, { title: "The Thing", summary: "now with detail" });
      expect(edited.revision).toBe(item.revision + 1);
      const last = board.events(item.id).at(-1)!;
      expect(last.kind).toBe("updated");
      expect(last.detail).toContain("The Thing");
      expect(last.revision).toBe(edited.revision);
    });
  });

  test("an edit that changes nothing is refused", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      expect(code(() => board.updateItem(item, {}))).toBe("nothing_to_update");
    });
  });
});

describe("claims", () => {
  test("a second agent is refused rather than queued", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      board.transition(item, "claim", { agent: "codex" });
      expect(code(() => board.transition(board.item(item.id)!, "claim", { agent: "other" }))).toBe(
        "already_claimed",
      );
    });
  });

  test("re-claiming as the same agent writes nothing", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      const first = board.transition(item, "claim", { agent: "codex" });
      const again = board.transition(first, "claim", { agent: "codex" });
      expect(again.revision).toBe(first.revision);
      expect(board.events(item.id).filter((event) => event.kind === "claimed")).toHaveLength(1);
    });
  });

  test("release returns the item to open and clears the claim", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      const claimed = board.transition(item, "claim", { agent: "codex" });
      const released = board.transition(claimed, "release");
      expect(released.state).toBe("open");
      expect(released.claim).toBeNull();
    });
  });

  test("waiting keeps the claim, and resuming gives the work back to its holder", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      const claimed = board.transition(item, "claim", { agent: "codex" });
      const parked = board.transition(claimed, "wait", { reason: "vendor reply" });
      expect(parked.claim?.agent).toBe("codex");
      expect(board.transition(parked, "resume").state).toBe("active");
    });
  });
});

describe("order", () => {
  test("every mutation leaves the ranks dense and unique", () => {
    withBoard((board) => {
      const ids = ["a", "b", "c", "d"].map((label) => board.addItem({ label }).id);
      board.reorder([ids[3]!, ids[0]!], { at: "first" });
      board.remove(board.item(ids[1]!)!, "not now");
      board.transition(board.item(ids[2]!)!, "done");
      const ranks = board.items().map((item) => item.rank);
      expect(ranks).toEqual([0, 1, 2, 3]);
    });
  });

  test("a tombstone keeps its rank and a restore returns the item to it", () => {
    withBoard((board) => {
      const ids = ["a", "b", "c"].map((label) => board.addItem({ label }).id);
      const removed = board.remove(board.item(ids[1]!)!, "not now");
      expect(removed.rank).toBe(1);
      expect(board.liveItems().map((item) => item.id)).toEqual([ids[0]!, ids[2]!]);
      const restored = board.restore(board.item(ids[1]!)!, "back on");
      expect(restored.rank).toBe(1);
      expect(restored.state).toBe("open");
    });
  });

  // Through real claims rather than fixtures: "do this next" must not jump the
  // moved work ahead of the second agent's item.
  test("next queues behind every claimed item, with two agents working", () => {
    withBoard((board) => {
      const ids = ["alice work", "idle between", "bob work", "later work"].map(
        (label) => board.addItem({ label }).id,
      );
      board.transition(board.item(ids[0]!)!, "claim", { agent: "alice" });
      board.transition(board.item(ids[2]!)!, "claim", { agent: "bob" });
      board.reorder([ids[3]!], { at: "next" });
      expect(board.items().map((item) => item.label)).toEqual([
        "alice work",
        "idle between",
        "bob work",
        "later work",
      ]);
      // Releasing bob's claim makes his item idle, so next now lands behind alice.
      board.transition(board.item(ids[2]!)!, "release");
      board.reorder([ids[3]!], { at: "next" });
      expect(board.items().map((item) => item.label)).toEqual([
        "alice work",
        "later work",
        "idle between",
        "bob work",
      ]);
    });
  });

  test("finishing an item does not re-rank the board", () => {
    withBoard((board) => {
      const ids = ["a", "b", "c"].map((label) => board.addItem({ label }).id);
      board.transition(board.item(ids[0]!)!, "done");
      expect(board.item(ids[0]!)!.rank).toBe(0);
      expect(board.item(ids[2]!)!.rank).toBe(2);
    });
  });
});

describe("relations", () => {
  test("a reversed symmetric edge is a duplicate, not a second edge", () => {
    withBoard((board) => {
      const a = board.addItem({ label: "a" });
      const b = board.addItem({ label: "b" });
      board.addRelation(a, b, "related-to", undefined, "human");
      expect(code(() => board.addRelation(b, a, "related-to", undefined, "human"))).toBe(
        "duplicate_relation",
      );
      expect(board.relations()).toHaveLength(1);
    });
  });

  test("an edge that would close a loop is refused", () => {
    withBoard((board) => {
      const a = board.addItem({ label: "a" });
      const b = board.addItem({ label: "b" });
      board.addRelation(a, b, "contains", undefined, "human");
      expect(code(() => board.addRelation(b, a, "contains", undefined, "human"))).toBe(
        "relation_cycle",
      );
    });
  });

  test("ready follows the depends-on graph and never a stored flag", () => {
    withBoard((board) => {
      const a = board.addItem({ label: "a" });
      const b = board.addItem({ label: "b" });
      board.addRelation(b, a, "depends-on", undefined, "human");
      expect(readyItems(board.openItems(), board.liveEdges()).map((item) => item.id)).toEqual([
        a.id,
      ]);
      board.transition(board.item(a.id)!, "done");
      expect(readyItems(board.openItems(), board.liveEdges()).map((item) => item.id)).toEqual([
        b.id,
      ]);
    });
  });
});

describe("audit", () => {
  test("every mutation appends an event and advances the revision", () => {
    withBoard((board) => {
      const item = board.addItem({ label: "the thing" });
      const claimed = board.transition(item, "claim", { agent: "codex" });
      const done = board.transition(claimed, "done", { note: "shipped" });
      expect(done.revision).toBeGreaterThan(item.revision);
      const kinds = board.events(item.id).map((event) => event.kind);
      expect(kinds).toEqual(["captured", "claimed", "done"]);
      expect(board.events(item.id).at(-1)?.revision).toBe(done.revision);
    });
  });

  test("the board revision moves when anything a groomer reads moves", () => {
    withBoard((board) => {
      const before = board.revision();
      const item = board.addItem({ label: "the thing" });
      const afterAdd = board.revision();
      expect(afterAdd).not.toBe(before);
      board.reorder([item.id], { at: "first" });
      board.addItem({ label: "second" });
      expect(board.revision()).not.toBe(afterAdd);
    });
  });

  test("a refused write leaves nothing behind", () => {
    withBoard((board) => {
      const a = board.addItem({ label: "a" });
      const before = board.revision();
      expect(() => board.addItem({ label: "A" })).toThrow(CliError);
      expect(() => board.reorder([a.id, "it-nothing"], { at: "first" })).toThrow(CliError);
      expect(board.revision()).toBe(before);
      expect(board.items()).toHaveLength(1);
    });
  });
});
