import { describe, expect, test } from "bun:test";
import { buildBrief, speakBrief } from "../src/brief.ts";
import type { Edge } from "../src/graph.ts";
import { ITEM_STATES, type Item, type ItemState, isOpenWork } from "../src/types.ts";
import { fakeItem, seeded } from "./helpers.ts";

const spoken = (items: Item[], edges: Edge[] = []): string =>
  speakBrief(buildBrief(items, edges), items.filter(isOpenWork));

describe("the spoken brief", () => {
  test("says the board is clear only when nothing is open", () => {
    expect(spoken([])).toMatch(/board is clear/);
    expect(spoken([fakeItem({ id: "it-1", label: "one thing" })])).not.toMatch(/board is clear/);
  });

  test("finished and removed work does not hold the all-clear back", () => {
    const closed = [
      fakeItem({ id: "it-1", label: "done thing", state: "done" }),
      fakeItem({ id: "it-2", label: "gone thing", deletedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(spoken(closed)).toMatch(/board is clear/);
  });

  test("speaks labels and reasons, never identifiers", () => {
    const items = [
      fakeItem({
        id: "it-abcd1234",
        label: "the auth cleanup",
        state: "active",
        claim: { agent: "codex", at: "now" },
      }),
      fakeItem({
        id: "it-beef5678",
        label: "the log panel",
        state: "waiting",
        stateReason: "vendor reply",
      }),
    ];
    const text = spoken(items);
    expect(text).toContain("the auth cleanup");
    expect(text).toContain("codex");
    expect(text).toContain("vendor reply");
    expect(text).not.toMatch(/it-[0-9a-f]{8}/);
  });

  test("says what a blocked item waits on", () => {
    const items = [
      fakeItem({ id: "it-1", label: "the log panel", rank: 0 }),
      fakeItem({ id: "it-2", label: "the auth cleanup", rank: 1 }),
    ];
    const text = spoken(items, [{ kind: "depends-on", from: "it-1", to: "it-2" }]);
    expect(text).toMatch(/Blocked: "the log panel" on "the auth cleanup"/);
  });

  // The guarantee the whole surface rests on: a person who hears nothing may
  // conclude the board is empty, so every open item must produce a line.
  test("names every live unfinished item, over many random boards", () => {
    const random = seeded(20260808);
    for (let round = 0; round < 300; round++) {
      const size = Math.floor(random() * 8);
      const items: Item[] = [];
      for (let index = 0; index < size; index++) {
        const state = ITEM_STATES[Math.floor(random() * ITEM_STATES.length)] as ItemState;
        items.push(
          fakeItem({
            id: `it-${index.toString(16).padStart(8, "0")}`,
            label: `item ${round} ${index}`,
            state,
            rank: index,
            ...(random() < 0.15 ? { deletedAt: "2026-01-01T00:00:00Z" } : {}),
            ...(state === "active" ? { claim: { agent: "codex", at: "now" } } : {}),
          }),
        );
      }
      const edges: Edge[] = [];
      for (let index = 1; index < items.length; index++) {
        if (random() < 0.3) {
          edges.push({ kind: "depends-on", from: items[index]!.id, to: items[index - 1]!.id });
        }
      }
      const open = items.filter(isOpenWork);
      const text = spoken(items, edges);
      for (const item of open) {
        expect(text).toContain(item.label);
      }
      if (open.length === 0) expect(text).toMatch(/board is clear/);
      expect(text).not.toMatch(/it-[0-9a-f]{8}/);
    }
  });

  test("an item in a state no bucket speaks for is still named", () => {
    // Stands in for a state added later without a bucket of its own.
    const rogue = fakeItem({ id: "it-1", label: "the rogue item", state: "invented" as ItemState });
    const brief = buildBrief([rogue], []);
    expect(brief.groups.find((group) => group.key === "other")?.items).toHaveLength(1);
    expect(speakBrief(brief, [rogue])).toContain("the rogue item");
  });
});
