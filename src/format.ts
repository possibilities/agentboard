/**
 * Human-readable rendering. Concise by default: an agent reads `--json`, and a
 * person reading a terminal wants the shape of the board, not every field.
 */

import type { Brief } from "./brief.ts";
import type { TreeNode } from "./graph.ts";
import type { Item, ItemEvent, Ref, Relation } from "./types.ts";

export function itemLine(item: Item): string {
  const tags = item.tags.length > 0 ? `  [${item.tags.join(" ")}]` : "";
  const claim = item.claim === null ? "" : `  ←${item.claim.agent}`;
  const removed = item.deletedAt === null ? "" : "  (removed)";
  return `${item.id}  ${String(item.rank).padStart(3)}  ${item.state.padEnd(10)}  ${item.title}${claim}${tags}${removed}`;
}

export function itemList(items: readonly Item[], empty: string): string {
  return items.length === 0 ? empty : items.map(itemLine).join("\n");
}

export function itemDetail(
  item: Item,
  relations: readonly Relation[],
  refs: readonly Ref[],
  titleOf: (id: string) => string,
  blockers: readonly Item[],
): string {
  const lines = [`${item.title}  (${item.id})`];
  if (item.label !== item.title) lines.push(`  label      ${item.label}`);
  lines.push(`  state      ${item.state}${item.stateReason ? ` — ${item.stateReason}` : ""}`);
  lines.push(`  order      ${item.rank}`);
  lines.push(`  origin     ${item.origin}`);
  if (item.claim !== null) lines.push(`  claim      ${item.claim.agent} since ${item.claim.at}`);
  if (item.tags.length > 0) lines.push(`  tags       ${item.tags.join(", ")}`);
  if (item.summary !== null) lines.push(`  summary    ${item.summary}`);
  if (item.deletedAt !== null) {
    lines.push(
      `  removed    ${item.deletedAt}${item.deletedReason ? ` — ${item.deletedReason}` : ""}`,
    );
  }
  for (const relation of relations) {
    const outward = relation.from === item.id;
    const other = outward ? relation.to : relation.from;
    const arrow = outward ? relation.kind : `${relation.kind} (from)`;
    lines.push(
      `  ${arrow.padEnd(20)} ${titleOf(other)}${relation.note ? ` — ${relation.note}` : ""}`,
    );
  }
  for (const ref of refs) lines.push(`  ref ${ref.rel.padEnd(16)} ${ref.target}`);
  if (blockers.length > 0) {
    lines.push(`  blocked on ${blockers.map((blocker) => blocker.title).join(", ")}`);
  }
  lines.push(`  revision   ${item.revision}`);
  return lines.join("\n");
}

export function eventLines(events: readonly ItemEvent[]): string {
  return events.length === 0
    ? "no events"
    : events
        .map(
          (event) =>
            `${event.at}  r${event.revision}  ${event.kind}${event.detail ? `  ${event.detail}` : ""}`,
        )
        .join("\n");
}

export function briefText(brief: Brief): string {
  if (brief.groups.length === 0) return "The board is clear.";
  const blocks = brief.groups.map((group) => {
    const rows = group.items.map((item) => {
      const waits = brief.blockers[item.id];
      const tail =
        waits !== undefined && waits.length > 0
          ? `  (on ${waits.join(", ")})`
          : item.stateReason
            ? `  — ${item.stateReason}`
            : "";
      return `  ${itemLine(item)}${tail}`;
    });
    return `${group.heading} (${group.items.length})\n${rows.join("\n")}`;
  });
  const { counts } = brief;
  return `${blocks.join("\n\n")}\n\n${counts.open} open · ${counts.active} underway · ${counts.ready} ready · ${counts.blocked} blocked`;
}

export function treeText(nodes: readonly TreeNode<Item>[]): string {
  if (nodes.length === 0) return "nothing to show";
  const lines: string[] = [];
  const walk = (node: TreeNode<Item>, depth: number): void => {
    lines.push(
      `${"  ".repeat(depth)}${node.item.title}  (${node.item.state}, order ${node.item.rank})`,
    );
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);
  return lines.join("\n");
}
