/**
 * The brief: what the board says when someone asks what is going on.
 *
 * The spoken variant is the load-bearing one. It speaks labels and nothing
 * else — no ids, no hashes, no paths — and it cannot produce a false all-clear:
 * the buckets below are followed by a catch-all built from the items that
 * actually produced a line, and then by a final fallback that names every open
 * item if somehow nothing did. Silence therefore means the board is empty, and
 * a future state that escapes every bucket is still spoken rather than lost.
 */

import { blockersOf, type Edge, readyItems } from "./graph.ts";
import type { Item } from "./types.ts";
import { isOpenWork } from "./types.ts";

export interface BriefGroup {
  key: "active" | "ready" | "blocked" | "waiting" | "paused" | "other";
  heading: string;
  items: Item[];
}

export interface Brief {
  groups: BriefGroup[];
  counts: { open: number; active: number; ready: number; blocked: number; done: number };
  /** Blockers per blocked item, so the spoken line can say what it waits on. */
  blockers: Record<string, string[]>;
}

/** Live items only; the caller passes the board and the brief filters it. */
export function buildBrief(items: readonly Item[], edges: readonly Edge[]): Brief {
  const live = items.filter((item) => item.deletedAt === null);
  const open = live.filter(isOpenWork);
  const ready = new Set(readyItems(open, edges).map((item) => item.id));

  const active = open.filter((item) => item.state === "active");
  const readyList = open.filter((item) => item.state === "open" && ready.has(item.id));
  const blocked = open.filter((item) => item.state === "open" && !ready.has(item.id));
  const waiting = open.filter((item) => item.state === "waiting");
  const paused = open.filter((item) => item.state === "paused");

  // Built from the items that actually landed in a bucket, never from "is it
  // open at all": a state no bucket speaks for must still be named.
  const spoken = new Set(
    [...active, ...readyList, ...blocked, ...waiting, ...paused].map((item) => item.id),
  );
  const other = open.filter((item) => !spoken.has(item.id));

  const blockers: Record<string, string[]> = {};
  for (const item of blocked) {
    blockers[item.id] = blockersOf(item.id, open, edges).map((blocker) => blocker.label);
  }

  const groups: BriefGroup[] = (
    [
      { key: "active", heading: "Underway", items: active },
      { key: "ready", heading: "Ready", items: readyList },
      { key: "blocked", heading: "Blocked", items: blocked },
      { key: "waiting", heading: "Waiting", items: waiting },
      { key: "paused", heading: "Paused", items: paused },
      { key: "other", heading: "Also open", items: other },
    ] satisfies BriefGroup[]
  ).filter((group) => group.items.length > 0);

  return {
    groups,
    counts: {
      open: open.length,
      active: active.length,
      ready: readyList.length,
      blocked: blocked.length,
      done: live.filter((item) => item.state === "done").length,
    },
    blockers,
  };
}

function names(items: readonly Item[]): string {
  return items.map((item) => `"${item.label}"`).join(", ");
}

/**
 * The spoken brief. Reads only labels, agent names, and reasons — the fields a
 * person can hear. The final fallback is a structural guarantee rather than an
 * argument about buckets: the all-clear is reachable only with nothing open.
 */
export function speakBrief(brief: Brief, open: readonly Item[]): string {
  const lines: string[] = [];
  const group = (key: BriefGroup["key"]): Item[] =>
    brief.groups.find((candidate) => candidate.key === key)?.items ?? [];

  const active = group("active");
  if (active.length > 0) {
    lines.push(
      `Underway: ${active
        .map((item) => `"${item.label}"${item.claim === null ? "" : ` with ${item.claim.agent}`}`)
        .join(", ")}.`,
    );
  }
  const ready = group("ready");
  if (ready.length > 0) {
    lines.push(`Ready to pick up: ${names(ready)}.`);
  }
  const blocked = group("blocked");
  if (blocked.length > 0) {
    lines.push(
      `Blocked: ${blocked
        .map((item) => {
          const waits = brief.blockers[item.id] ?? [];
          return waits.length === 0
            ? `"${item.label}"`
            : `"${item.label}" on ${waits.map((label) => `"${label}"`).join(" and ")}`;
        })
        .join("; ")}.`,
    );
  }
  for (const [key, lead] of [
    ["waiting", "Waiting"],
    ["paused", "Paused"],
  ] as const) {
    const items = group(key);
    if (items.length === 0) continue;
    lines.push(
      `${lead}: ${items
        .map((item) => `"${item.label}"${item.stateReason ? ` — ${item.stateReason}` : ""}`)
        .join("; ")}.`,
    );
  }
  const other = group("other");
  if (other.length > 0) {
    lines.push(`Also open: ${names(other)}.`);
  }

  if (lines.length === 0) {
    if (open.length > 0) return `Still open: ${names(open)}.`;
    return "The board is clear. Nothing is captured and nothing is waiting.";
  }
  return lines.join("\n");
}
