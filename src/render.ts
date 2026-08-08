/**
 * A board snapshot as one self-contained HTML string: a kanban view grouped
 * by state and a containment-tree view. No network, no build step — the
 * browser is the only runtime this ever needs.
 */

import type { TreeNode } from "./graph.ts";
import {
  ITEM_STATES,
  type Item,
  type ItemState,
  type Ref,
  type Relation,
  type RelationKind,
} from "./types.ts";

export interface RenderInput {
  items: Item[]; // LIVE items only, already in board (rank) order
  relations: Relation[];
  refs: Ref[];
  tree: TreeNode<Item>[]; // containment forest, already built by the caller
  generatedAt: string; // ISO timestamp
}

const STATE_LABELS: Record<ItemState, string> = {
  open: "Open",
  active: "Active",
  waiting: "Waiting",
  paused: "Paused",
  done: "Done",
  superseded: "Superseded",
  cancelled: "Cancelled",
};

// Read from the current card's point of view: forward when the card is the
// edge's `from`, reversed when it's the `to`. Symmetric kinds read the same
// either way, so both maps agree for them.
const FORWARD_LABEL: Record<RelationKind, string> = {
  contains: "contains",
  "depends-on": "depends on",
  "conflicts-with": "conflicts with",
  supersedes: "supersedes",
  "related-to": "related to",
};
const REVERSE_LABEL: Record<RelationKind, string> = {
  contains: "contained by",
  "depends-on": "depended on by",
  "conflicts-with": "conflicts with",
  supersedes: "superseded by",
  "related-to": "related to",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// String slicing rather than Date formatting: the output must not depend on
// the rendering machine's locale or timezone.
function formatTimestamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z)?/.exec(iso);
  if (match === null) return escapeHtml(iso);
  const date = match[1];
  const time = match[2];
  if (date === undefined || time === undefined) return escapeHtml(iso);
  return match[3] === "Z" ? `${date} ${time} UTC` : `${date} ${time}`;
}

function indexById(items: readonly Item[]): Map<string, Item> {
  return new Map(items.map((item) => [item.id, item]));
}

// Every relation touching an item, from either endpoint, keyed by item id.
function relationsByItem(relations: readonly Relation[]): Map<string, Relation[]> {
  const map = new Map<string, Relation[]>();
  const add = (id: string, relation: Relation) => {
    const list = map.get(id);
    if (list === undefined) map.set(id, [relation]);
    else list.push(relation);
  };
  for (const relation of relations) {
    add(relation.from, relation);
    if (relation.to !== relation.from) add(relation.to, relation);
  }
  return map;
}

function refsByItem(refs: readonly Ref[]): Map<string, Ref[]> {
  const map = new Map<string, Ref[]>();
  for (const ref of refs) {
    const list = map.get(ref.itemId);
    if (list === undefined) map.set(ref.itemId, [ref]);
    else list.push(ref);
  }
  return map;
}

function renderTags(tags: readonly string[]): string {
  if (tags.length === 0) return "";
  const pills = tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("");
  return `<div class="tags">${pills}</div>`;
}

function renderRelations(
  item: Item,
  relations: readonly Relation[],
  itemsById: Map<string, Item>,
): string {
  if (relations.length === 0) return "";
  const lines = relations.map((relation) => {
    const forward = relation.from === item.id;
    const otherId = forward ? relation.to : relation.from;
    const other = itemsById.get(otherId);
    const label = forward ? FORWARD_LABEL[relation.kind] : REVERSE_LABEL[relation.kind];
    const otherHtml =
      other === undefined
        ? `<span class="unresolved">${escapeHtml(otherId)}</span>`
        : escapeHtml(other.title);
    const note =
      relation.note === null || relation.note.trim() === ""
        ? ""
        : ` <span class="muted">(${escapeHtml(relation.note)})</span>`;
    return `<li><span class="rel-kind">${escapeHtml(label)}</span> ${otherHtml}${note}</li>`;
  });
  return (
    `<div class="field"><span class="field-label">Relations</span>` +
    `<ul class="rel-list">${lines.join("")}</ul></div>`
  );
}

function renderRefs(refs: readonly Ref[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((ref) => {
    const isLink = /^https?:\/\//.test(ref.target);
    const targetHtml = isLink
      ? `<a href="${escapeHtml(ref.target)}" target="_blank" rel="noopener noreferrer">` +
        `${escapeHtml(ref.target)}</a>`
      : `<code>${escapeHtml(ref.target)}</code>`;
    return `<li><span class="ref-rel">${escapeHtml(ref.rel)}</span> ${targetHtml}</li>`;
  });
  return (
    `<div class="field"><span class="field-label">Refs</span>` +
    `<ul class="ref-list">${lines.join("")}</ul></div>`
  );
}

function renderCard(
  item: Item,
  itemsById: Map<string, Item>,
  relByItem: Map<string, Relation[]>,
  refByItem: Map<string, Ref[]>,
): string {
  const parts: string[] = [];
  parts.push(`<div class="card">`);
  parts.push(`<div class="card-title">${escapeHtml(item.title)}</div>`);
  if (item.label !== item.title) {
    parts.push(`<div class="card-label">${escapeHtml(item.label)}</div>`);
  }
  parts.push(`<div class="card-meta"><span class="rank">#${item.rank}</span></div>`);
  parts.push(renderTags(item.tags));
  if (item.claim !== null) {
    parts.push(
      `<div class="field"><span class="field-label">Claim</span> ` +
        `${escapeHtml(item.claim.agent)} ` +
        `<span class="muted">at ${formatTimestamp(item.claim.at)}</span></div>`,
    );
  }
  if (item.stateReason !== null && item.stateReason.trim() !== "") {
    parts.push(
      `<div class="field"><span class="field-label">Reason</span> ` +
        `${escapeHtml(item.stateReason)}</div>`,
    );
  }
  if (item.summary !== null && item.summary.trim() !== "") {
    parts.push(`<div class="field summary">${escapeHtml(item.summary)}</div>`);
  }
  parts.push(renderRelations(item, relByItem.get(item.id) ?? [], itemsById));
  parts.push(renderRefs(refByItem.get(item.id) ?? []));
  parts.push(`<div class="card-id">${escapeHtml(item.id)}</div>`);
  parts.push(`</div>`);
  return parts.join("");
}

function renderColumn(
  state: ItemState,
  items: readonly Item[],
  itemsById: Map<string, Item>,
  relByItem: Map<string, Relation[]>,
  refByItem: Map<string, Ref[]>,
): string {
  const cards =
    items.length === 0
      ? `<div class="empty">none</div>`
      : items.map((item) => renderCard(item, itemsById, relByItem, refByItem)).join("");
  return (
    `<div class="column">` +
    `<div class="column-header badge-${state}">${STATE_LABELS[state]} ` +
    `<span class="count">${items.length}</span></div>` +
    `<div class="column-body">${cards}</div>` +
    `</div>`
  );
}

function renderKanban(input: RenderInput, itemsById: Map<string, Item>): string {
  const relByItem = relationsByItem(input.relations);
  const refByItem = refsByItem(input.refs);
  const columns = ITEM_STATES.map((state) => {
    const columnItems = input.items.filter((item) => item.state === state);
    return renderColumn(state, columnItems, itemsById, relByItem, refByItem);
  }).join("");
  return `<div class="kanban-scroll"><div class="kanban">${columns}</div></div>`;
}

function renderTreeNode(node: TreeNode<Item>): string {
  const item = node.item;
  const children =
    node.children.length === 0 ? "" : `<ul>${node.children.map(renderTreeNode).join("")}</ul>`;
  return (
    `<li><span class="tree-title">${escapeHtml(item.title)}</span> ` +
    `<span class="badge badge-${item.state}">${STATE_LABELS[item.state]}</span> ` +
    `<span class="tree-rank">#${item.rank}</span>${children}</li>`
  );
}

function renderTree(tree: readonly TreeNode<Item>[]): string {
  if (tree.length === 0) return `<div class="empty">none</div>`;
  return `<ul class="tree-root">${tree.map(renderTreeNode).join("")}</ul>`;
}

function renderCounts(items: readonly Item[]): string {
  const counts = new Map<ItemState, number>(ITEM_STATES.map((state) => [state, 0]));
  for (const item of items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  const pills = ITEM_STATES.map(
    (state) =>
      `<span class="count-pill badge-${state}">${STATE_LABELS[state]} ${counts.get(state) ?? 0}</span>`,
  ).join("");
  return `<div class="counts"><span class="count-total">${items.length} total</span>${pills}</div>`;
}

const STYLE = `
:root {
  --bg: #f6f7f9;
  --fg: #1c1f26;
  --muted: #6b7280;
  --border: #dde1e6;
  --card-bg: #ffffff;
  --header-bg: #ffffff;
  --accent: #2563eb;
  --code-bg: #eef0f3;
  --shadow: 0 1px 2px rgba(15, 23, 42, 0.06);

  --state-open-bg: #dbeafe;
  --state-open-fg: #1e3a8a;
  --state-active-bg: #dcfce7;
  --state-active-fg: #14532d;
  --state-waiting-bg: #fef3c7;
  --state-waiting-fg: #78350f;
  --state-paused-bg: #ede9fe;
  --state-paused-fg: #4c1d95;
  --state-done-bg: #d1fae5;
  --state-done-fg: #065f46;
  --state-superseded-bg: #e2e8f0;
  --state-superseded-fg: #334155;
  --state-cancelled-bg: #fee2e2;
  --state-cancelled-fg: #7f1d1d;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e6e7eb;
    --muted: #9aa1ac;
    --border: #2c3038;
    --card-bg: #1c1f26;
    --header-bg: #1c1f26;
    --accent: #60a5fa;
    --code-bg: #23262d;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);

    --state-open-bg: #1e3a8a;
    --state-open-fg: #dbeafe;
    --state-active-bg: #14532d;
    --state-active-fg: #dcfce7;
    --state-waiting-bg: #78350f;
    --state-waiting-fg: #fef3c7;
    --state-paused-bg: #4c1d95;
    --state-paused-fg: #ede9fe;
    --state-done-bg: #065f46;
    --state-done-fg: #d1fae5;
    --state-superseded-bg: #334155;
    --state-superseded-fg: #e2e8f0;
    --state-cancelled-bg: #7f1d1d;
    --state-cancelled-fg: #fee2e2;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}

header {
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  padding: 16px 20px;
  position: sticky;
  top: 0;
}

h1 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.generated {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 10px;
}

.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 10px;
}

.count-total {
  font-weight: 600;
  margin-right: 6px;
}

.count-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
}

.view-toggle {
  display: flex;
  gap: 6px;
}

.toggle-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.toggle-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

main {
  padding: 16px 20px 40px;
}

.view.hidden {
  display: none;
}

.kanban-scroll,
.tree-scroll {
  overflow-x: auto;
}

.kanban {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-width: min-content;
}

.column {
  flex: 0 0 260px;
  width: 260px;
}

.column-header {
  font-weight: 600;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px 6px 0 0;
  display: flex;
  justify-content: space-between;
}

.column-header .count {
  opacity: 0.75;
  font-weight: 500;
}

.column-body {
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 40px;
}

.empty {
  color: var(--muted);
  font-style: italic;
  font-size: 12px;
  padding: 4px;
}

.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  box-shadow: var(--shadow);
}

.card-title {
  font-weight: 600;
  word-break: break-word;
}

.card-label {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}

.card-meta {
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

.card-id {
  margin-top: 8px;
  font-size: 10px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.pill {
  background: var(--code-bg);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
}

.field {
  margin-top: 6px;
  font-size: 12px;
}

.field-label {
  font-weight: 600;
  margin-right: 4px;
}

.muted {
  color: var(--muted);
}

.unresolved {
  color: var(--muted);
  font-style: italic;
}

.rel-list,
.ref-list {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
}

.rel-list li,
.ref-list li {
  margin-top: 2px;
}

.rel-kind,
.ref-rel {
  color: var(--muted);
  margin-right: 4px;
}

code {
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 11px;
}

a {
  color: var(--accent);
}

.badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 999px;
  margin-left: 6px;
}

.badge-open,
.column-header.badge-open,
.count-pill.badge-open {
  background: var(--state-open-bg);
  color: var(--state-open-fg);
}

.badge-active,
.column-header.badge-active,
.count-pill.badge-active {
  background: var(--state-active-bg);
  color: var(--state-active-fg);
}

.badge-waiting,
.column-header.badge-waiting,
.count-pill.badge-waiting {
  background: var(--state-waiting-bg);
  color: var(--state-waiting-fg);
}

.badge-paused,
.column-header.badge-paused,
.count-pill.badge-paused {
  background: var(--state-paused-bg);
  color: var(--state-paused-fg);
}

.badge-done,
.column-header.badge-done,
.count-pill.badge-done {
  background: var(--state-done-bg);
  color: var(--state-done-fg);
}

.badge-superseded,
.column-header.badge-superseded,
.count-pill.badge-superseded {
  background: var(--state-superseded-bg);
  color: var(--state-superseded-fg);
}

.badge-cancelled,
.column-header.badge-cancelled,
.count-pill.badge-cancelled {
  background: var(--state-cancelled-bg);
  color: var(--state-cancelled-fg);
}

.tree-root,
.tree-root ul {
  list-style: none;
  margin: 0;
  padding-left: 18px;
}

.tree-root {
  padding-left: 0;
}

.tree-root li {
  margin: 4px 0;
  white-space: nowrap;
}

.tree-title {
  font-weight: 500;
}

.tree-rank {
  color: var(--muted);
  font-size: 11px;
  margin-left: 6px;
}
`;

const SCRIPT = `
(function () {
  var buttons = document.querySelectorAll(".toggle-btn");
  buttons.forEach(function (button) {
    button.addEventListener("click", function () {
      var view = button.getAttribute("data-view");
      document.querySelectorAll(".view").forEach(function (section) {
        section.classList.toggle("hidden", section.id !== "view-" + view);
      });
      buttons.forEach(function (b) {
        b.classList.toggle("active", b === button);
      });
    });
  });
})();
`;

export function renderBoard(input: RenderInput): string {
  const itemsById = indexById(input.items);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentboard</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>agentboard</h1>
  <div class="generated">Generated ${formatTimestamp(input.generatedAt)}</div>
  ${renderCounts(input.items)}
  <div class="view-toggle">
    <button type="button" class="toggle-btn active" data-view="kanban">Kanban</button>
    <button type="button" class="toggle-btn" data-view="tree">Tree</button>
  </div>
</header>
<main>
  <section id="view-kanban" class="view">
    ${renderKanban(input, itemsById)}
  </section>
  <section id="view-tree" class="view hidden">
    <div class="tree-scroll">${renderTree(input.tree)}</div>
  </section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
