import { describe, expect, test } from "bun:test";
import { rankCandidates, resolveRef } from "../src/resolve.ts";
import { fakeItem } from "./helpers.ts";

const board = [
  fakeItem({ id: "it-00000001", label: "the auth cleanup", topicKey: "auth-cleanup", rank: 0 }),
  fakeItem({ id: "it-00000002", label: "the log panel", topicKey: "log-panel", rank: 1 }),
  fakeItem({
    id: "it-00000003",
    label: "the log panel rewrite",
    topicKey: "log-panel-rewrite",
    rank: 2,
  }),
];

describe("resolveRef", () => {
  test("an exact id wins outright", () => {
    expect(resolveRef("it-00000002", board).id).toBe("it-00000002");
  });

  test("an exact label beats a phrase that merely occurs in another label", () => {
    expect(resolveRef("the log panel", board).id).toBe("it-00000002");
  });

  test("the same topic said differently resolves", () => {
    expect(resolveRef("Auth cleanup", board).id).toBe("it-00000001");
    expect(resolveRef("a log panel", board).id).toBe("it-00000002");
  });

  test("an unambiguous fragment resolves", () => {
    expect(resolveRef("rewrite", board).id).toBe("it-00000003");
  });

  test("an ambiguous fragment is refused, naming the candidates", () => {
    expect(() => resolveRef("log", board)).toThrow(/names 2 items/);
    expect(() => resolveRef("log", board)).toThrow(/the log panel/);
  });

  test("a phrase that names nothing is refused with unknown_ref", () => {
    try {
      resolveRef("nothing like this", board);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code: string }).code).toBe("unknown_ref");
    }
  });

  test("live work outranks a tombstone that matched the same way", () => {
    const withTombstone = [
      ...board,
      fakeItem({
        id: "it-00000004",
        label: "the auth cleanup",
        topicKey: "auth-cleanup",
        rank: 3,
        deletedAt: "2026-01-01T00:00:00Z",
      }),
    ];
    expect(resolveRef("the auth cleanup", withTombstone).id).toBe("it-00000001");
  });

  test("a tombstone is still reachable when nothing live matches — restore needs it", () => {
    const removed = [
      fakeItem({
        id: "it-00000009",
        label: "the old thing",
        topicKey: "old-thing",
        rank: 0,
        deletedAt: "2026-01-01T00:00:00Z",
      }),
    ];
    expect(resolveRef("the old thing", removed).id).toBe("it-00000009");
  });

  test("a blank reference is refused rather than matching everything", () => {
    expect(() => resolveRef("   ", board)).toThrow(/cannot be blank/);
  });
});

describe("rankCandidates", () => {
  test("reports the tier that matched, strongest first", () => {
    const ranked = rankCandidates("log panel", board);
    expect(ranked.map((candidate) => candidate.item.id)).toEqual(["it-00000002", "it-00000003"]);
    expect(ranked[0]!.tier).toBe("topic");
    expect(ranked[1]!.tier).toBe("contains");
  });

  test("names each item at most once", () => {
    const ranked = rankCandidates("the auth cleanup", board);
    expect(new Set(ranked.map((candidate) => candidate.item.id)).size).toBe(ranked.length);
  });
});
