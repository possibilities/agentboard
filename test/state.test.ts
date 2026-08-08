import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors.ts";
import { assertClaimable, assertMutable, nextState, requireReason } from "../src/state.ts";
import { type ItemState, TERMINAL_STATES } from "../src/types.ts";
import { fakeItem } from "./helpers.ts";

const item = (state: ItemState, claim: { agent: string; at: string } | null = null) =>
  fakeItem({ id: "it-00000001", label: "the thing", state, claim });

describe("transition legality", () => {
  test("claim takes open work and nothing else", () => {
    expect(nextState(item("open"), "claim")).toBe("active");
    for (const state of ["waiting", "paused"] as ItemState[]) {
      expect(() => nextState(item(state), "claim")).toThrow(/only open work can be claimed/);
    }
  });

  test("release needs a claim and returns the item to open", () => {
    expect(nextState(item("active", { agent: "codex", at: "now" }), "release")).toBe("open");
    expect(() => nextState(item("open"), "release")).toThrow(/not claimed/);
  });

  test("resume returns to active only while the claim is still held", () => {
    expect(nextState(item("paused", { agent: "codex", at: "now" }), "resume")).toBe("active");
    expect(nextState(item("waiting"), "resume")).toBe("open");
    expect(() => nextState(item("open"), "resume")).toThrow(/only waiting or paused/);
  });

  test("terminal states are frozen against every transition", () => {
    for (const state of TERMINAL_STATES) {
      for (const transition of [
        "claim",
        "release",
        "done",
        "cancel",
        "wait",
        "pause",
        "resume",
      ] as const) {
        expect(() => nextState(item(state), transition)).toThrow(/frozen/);
      }
    }
  });

  test("a removed item is refused before its state is even considered", () => {
    const removed = fakeItem({ id: "it-1", label: "gone", deletedAt: "2026-01-01T00:00:00Z" });
    expect(() => assertMutable(removed, "editing it")).toThrow(/removed from the board/);
  });
});

describe("reasons", () => {
  test("waiting, paused, cancelled, and superseded require one", () => {
    for (const state of ["waiting", "paused", "cancelled", "superseded"] as ItemState[]) {
      expect(() => requireReason(state, "  ")).toThrow(CliError);
      expect(requireReason(state, " because ")).toBe("because");
    }
  });

  test("open, active, and done do not", () => {
    for (const state of ["open", "active", "done"] as ItemState[]) {
      expect(requireReason(state, undefined)).toBeNull();
    }
  });
});

describe("claims", () => {
  test("a second agent is refused, and the holder is named", () => {
    const held = item("active", { agent: "codex", at: "now" });
    expect(() => assertClaimable(held, "other")).toThrow(/claimed by codex/);
    expect(() => assertClaimable(held, "codex")).not.toThrow();
  });
});
