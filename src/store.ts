/**
 * The board itself: every read, every mutation, and the bookkeeping that makes
 * a mutation auditable.
 *
 * Three invariants hold for every write, which is why they all funnel through
 * `write`: the transaction is `BEGIN IMMEDIATE` so two agents cannot interleave
 * a read-modify-write, the item's event log gains a row, and its `revision`
 * advances. A refused write leaves nothing behind.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { CliError } from "./errors.ts";
import { assertAcyclic, canonicalEdge, type Edge } from "./graph.ts";
import {
  bySequence,
  describePlacement,
  type Placement,
  placeItems,
  type Rankable,
} from "./order.ts";
import { resolveRef } from "./resolve.ts";
import {
  assertClaimable,
  assertLive,
  assertMutable,
  nextState,
  requireReason,
  type Transition,
} from "./state.ts";
import { normalizeLabel, topicKeyFor } from "./topic.ts";
import {
  type Item,
  type ItemEvent,
  type ItemState,
  isOpenWork,
  isTerminal,
  type Origin,
  type Ref,
  type RefRel,
  type Relation,
  type RelationKind,
} from "./types.ts";

interface ItemRow {
  id: string;
  label: string;
  title: string;
  topic_key: string;
  summary: string | null;
  state: string;
  state_reason: string | null;
  origin: string;
  order_rank: number;
  claim_agent: string | null;
  claim_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_reason: string | null;
  revision: number;
}

interface RelationRow {
  id: number;
  kind: string;
  from_id: string;
  to_id: string;
  note: string | null;
  origin: string;
  created_at: string;
}

interface RefRow {
  id: number;
  item_id: string;
  target: string;
  rel: string;
  created_at: string;
}

interface EventRow {
  id: number;
  item_id: string;
  at: string;
  kind: string;
  detail: string | null;
  revision: number;
}

export interface AddItemInput {
  label: string;
  title?: string;
  summary?: string;
  tags?: string[];
  origin?: Origin;
  /** Capture a second item on a topic the board already carries. */
  allowDuplicateTopic?: boolean;
}

export interface UpdateItemInput {
  label?: string;
  title?: string;
  summary?: string;
  tags?: string[];
  note?: string;
}

export interface GroomingAudit {
  draftId: string;
  draftDigest: string;
  scope: string | null;
  scopeItemIds: string[] | null;
  expansions: { id: string; reason: string }[];
  summary: string;
  operations: unknown[];
  removedRelations: Relation[];
  created: { tempId: string; id: string }[];
  baseRevision: string;
  resultRevision: string;
  appliedAt: string;
  counts: Record<string, number>;
}

const ITEM_COLUMNS =
  "id, label, title, topic_key, summary, state, state_reason, origin, order_rank, claim_agent, claim_at, created_at, updated_at, deleted_at, deleted_reason, revision";

export class Board {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  close(): void {
    this.db.close();
  }

  stamp(): string {
    return this.now().toISOString();
  }

  /**
   * One write, all or nothing. `BEGIN IMMEDIATE` takes the write lock before
   * the first read, so a claim cannot be granted twice by two agents that both
   * looked first — the loser waits out `busy_timeout` and then sees the claim.
   */
  write<T>(body: () => T): T {
    return this.db.transaction(body).immediate();
  }

  // --- Reads ---

  private hydrate(rows: ItemRow[]): Item[] {
    const tags = new Map<string, string[]>();
    for (const row of this.db.query("SELECT item_id, tag FROM item_tags ORDER BY tag").all() as {
      item_id: string;
      tag: string;
    }[]) {
      const list = tags.get(row.item_id);
      if (list === undefined) tags.set(row.item_id, [row.tag]);
      else list.push(row.tag);
    }
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      title: row.title,
      topicKey: row.topic_key,
      summary: row.summary,
      tags: tags.get(row.id) ?? [],
      state: row.state as ItemState,
      stateReason: row.state_reason,
      origin: row.origin as Origin,
      rank: row.order_rank,
      claim:
        row.claim_agent === null || row.claim_at === null
          ? null
          : { agent: row.claim_agent, at: row.claim_at },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      deletedReason: row.deleted_reason,
      revision: row.revision,
    }));
  }

  /** Every row, tombstones included, in the one canonical order. */
  items(): Item[] {
    const rows = this.db
      .query(`SELECT ${ITEM_COLUMNS} FROM items ORDER BY order_rank, created_at, id`)
      .all() as ItemRow[];
    return this.hydrate(rows);
  }

  /** The operational view: what a reader is allowed to see at all. */
  liveItems(): Item[] {
    return this.items().filter((item) => item.deletedAt === null);
  }

  /** The backlog: live and unfinished, the subsequence every listing filters to. */
  openItems(): Item[] {
    return this.items().filter(isOpenWork);
  }

  item(id: string): Item | null {
    const row = this.db
      .query(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`)
      .get(id) as ItemRow | null;
    return row === null ? null : (this.hydrate([row])[0] ?? null);
  }

  relations(): Relation[] {
    const rows = this.db
      .query("SELECT id, kind, from_id, to_id, note, origin, created_at FROM relations ORDER BY id")
      .all() as RelationRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as RelationKind,
      from: row.from_id,
      to: row.to_id,
      note: row.note,
      origin: row.origin as Origin,
      createdAt: row.created_at,
    }));
  }

  /** Edges whose endpoints are both live: the graph every derived view uses. */
  liveEdges(): Edge[] {
    const live = new Set(this.liveItems().map((item) => item.id));
    return this.relations()
      .filter((relation) => live.has(relation.from) && live.has(relation.to))
      .map((relation) => ({ kind: relation.kind, from: relation.from, to: relation.to }));
  }

  refs(itemId?: string): Ref[] {
    const rows = (
      itemId === undefined
        ? this.db.query("SELECT id, item_id, target, rel, created_at FROM refs ORDER BY id").all()
        : this.db
            .query(
              "SELECT id, item_id, target, rel, created_at FROM refs WHERE item_id = ? ORDER BY id",
            )
            .all(itemId)
    ) as RefRow[];
    return rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      target: row.target,
      rel: row.rel as RefRel,
      createdAt: row.created_at,
    }));
  }

  events(itemId?: string): ItemEvent[] {
    const rows = (
      itemId === undefined
        ? this.db
            .query("SELECT id, item_id, at, kind, detail, revision FROM events ORDER BY id")
            .all()
        : this.db
            .query(
              "SELECT id, item_id, at, kind, detail, revision FROM events WHERE item_id = ? ORDER BY id",
            )
            .all(itemId)
    ) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      at: row.at,
      kind: row.kind,
      detail: row.detail,
      revision: row.revision,
    }));
  }

  groomings(): GroomingAudit[] {
    const rows = this.db.query("SELECT * FROM groomings ORDER BY applied_at, draft_id").all() as {
      draft_id: string;
      draft_digest: string;
      scope: string | null;
      scope_item_ids: string | null;
      expansions: string;
      summary: string;
      operations: string;
      removed_relations: string;
      created_bindings: string;
      base_revision: string;
      result_revision: string;
      applied_at: string;
      counts: string;
    }[];
    return rows.map((row) => ({
      draftId: row.draft_id,
      draftDigest: row.draft_digest,
      scope: row.scope,
      scopeItemIds:
        row.scope_item_ids === null ? null : (JSON.parse(row.scope_item_ids) as string[]),
      expansions: JSON.parse(row.expansions) as { id: string; reason: string }[],
      summary: row.summary,
      operations: JSON.parse(row.operations) as unknown[],
      removedRelations: JSON.parse(row.removed_relations) as Relation[],
      created: JSON.parse(row.created_bindings) as { tempId: string; id: string }[],
      baseRevision: row.base_revision,
      resultRevision: row.result_revision,
      appliedAt: row.applied_at,
      counts: JSON.parse(row.counts) as Record<string, number>,
    }));
  }

  grooming(draftId: string): GroomingAudit | null {
    return this.groomings().find((record) => record.draftId === draftId) ?? null;
  }

  /**
   * The staleness token. A digest over exactly what `groom export` shows a
   * groomer — every item's semantic fields and every relation — so any fact the
   * draft could have reasoned from invalidates it when it moves. Tombstones are
   * included, so a removal or a restore between export and apply is stale too.
   * Refs are not: grooming has no operation that reads or writes them.
   */
  revision(): string {
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          items: this.items().map((item) => ({
            id: item.id,
            label: item.label,
            title: item.title,
            topicKey: item.topicKey,
            summary: item.summary,
            tags: item.tags,
            state: item.state,
            stateReason: item.stateReason,
            origin: item.origin,
            rank: item.rank,
            claim: item.claim,
            deletedAt: item.deletedAt,
          })),
          relations: this.relations()
            .map((relation) => ({
              kind: relation.kind,
              from: relation.from,
              to: relation.to,
              note: relation.note,
            }))
            .sort((left, right) =>
              `${left.kind} ${left.from} ${left.to}` < `${right.kind} ${right.from} ${right.to}`
                ? -1
                : 1,
            ),
        }),
      )
      .digest("hex");
    return `br1-${digest}`;
  }

  /** Resolve a spoken phrase against the whole board, tombstones included. */
  resolve(phrase: string): Item {
    return resolveRef(phrase, this.items());
  }

  // --- Write primitives (call inside `write`) ---

  private mintId(): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const bytes = crypto.getRandomValues(new Uint8Array(4));
      const id = `it-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const clash = this.db.query("SELECT 1 FROM items WHERE id = ?").get(id);
      if (clash === null) return id;
    }
    throw new CliError("id_exhausted", "could not mint an unused item id after 16 attempts");
  }

  /** Advance an item's revision and record why. Every mutation ends here. */
  private touch(id: string, kind: string, detail: string | null, at: string): number {
    const row = this.db.query("SELECT revision FROM items WHERE id = ?").get(id) as {
      revision: number;
    } | null;
    if (row === null) throw new CliError("unknown_ref", `unknown item: ${id}`);
    const revision = row.revision + 1;
    this.db.run("UPDATE items SET revision = ?, updated_at = ? WHERE id = ?", [revision, at, id]);
    this.db.run("INSERT INTO events (item_id, at, kind, detail, revision) VALUES (?, ?, ?, ?, ?)", [
      id,
      at,
      kind,
      detail,
      revision,
    ]);
    return revision;
  }

  private setTags(id: string, tags: string[]): void {
    this.db.run("DELETE FROM item_tags WHERE item_id = ?", [id]);
    for (const tag of [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]) {
      this.db.run("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)", [id, tag]);
    }
  }

  /** Renumber the whole sequence from a permutation of it. */
  private applySequence(sequence: readonly { id: string }[]): void {
    sequence.forEach((item, rank) => {
      this.db.run("UPDATE items SET order_rank = ? WHERE id = ?", [rank, item.id]);
    });
  }

  // --- Domain operations ---

  addItem(input: AddItemInput): Item {
    return this.write(() => this.addItemIn(input));
  }

  addItemIn(input: AddItemInput): Item {
    const label = normalizeLabel(input.label);
    if (label.length === 0) {
      throw new CliError("blank_label", "an item needs a speakable label");
    }
    const topicKey = topicKeyFor(label);
    if (input.allowDuplicateTopic !== true) {
      const existing = this.items().find((item) => item.topicKey === topicKey && isOpenWork(item));
      if (existing !== undefined) {
        throw new CliError(
          "existing_topic",
          `"${existing.label}" (${existing.id}) is already on the board for that topic`,
          "add to it instead, or pass --new to capture a second item on the same topic",
        );
      }
    }
    const at = this.stamp();
    const id = this.mintId();
    const rank = (this.db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    this.db.run(
      `INSERT INTO items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 0)`,
      [
        id,
        label,
        normalizeLabel(input.title ?? label),
        topicKey,
        input.summary?.trim() || null,
        input.origin ?? "human",
        rank,
        at,
        at,
      ],
    );
    this.setTags(id, input.tags ?? []);
    this.touch(id, "captured", null, at);
    const created = this.item(id);
    if (created === null) throw new CliError("write_failed", "the item did not survive its insert");
    return created;
  }

  updateItem(item: Item, input: UpdateItemInput): Item {
    return this.write(() => this.updateItemIn(item, input));
  }

  updateItemIn(item: Item, input: UpdateItemInput): Item {
    assertMutable(item, "editing it");
    const changes: string[] = [];
    const at = this.stamp();
    if (input.label !== undefined) {
      const label = normalizeLabel(input.label);
      if (label.length === 0) throw new CliError("blank_label", "an item needs a speakable label");
      this.db.run("UPDATE items SET label = ?, topic_key = ? WHERE id = ?", [
        label,
        topicKeyFor(label),
        item.id,
      ]);
      changes.push(`label → "${label}"`);
    }
    if (input.title !== undefined) {
      const title = normalizeLabel(input.title);
      if (title.length === 0) throw new CliError("blank_title", "a title cannot be blank");
      this.db.run("UPDATE items SET title = ? WHERE id = ?", [title, item.id]);
      changes.push(`title → "${title}"`);
    }
    if (input.summary !== undefined) {
      this.db.run("UPDATE items SET summary = ? WHERE id = ?", [
        input.summary.trim() || null,
        item.id,
      ]);
      changes.push("summary rewritten");
    }
    if (input.tags !== undefined) {
      this.setTags(item.id, input.tags);
      changes.push(`tags → ${input.tags.join(", ") || "none"}`);
    }
    if (changes.length === 0 && input.note === undefined) {
      throw new CliError("nothing_to_update", "give at least one field to change, or a note");
    }
    const detail = [changes.join("; "), input.note?.trim()].filter(Boolean).join(" — ");
    this.touch(item.id, "updated", detail || null, at);
    return this.item(item.id)!;
  }

  /** Every state move: one place, so legality and the event log cannot diverge. */
  transition(
    item: Item,
    transition: Transition,
    options: { reason?: string; note?: string; agent?: string } = {},
  ): Item {
    return this.write(() => this.transitionIn(item, transition, options));
  }

  transitionIn(
    item: Item,
    transition: Transition,
    options: { reason?: string; note?: string; agent?: string } = {},
  ): Item {
    if (transition === "claim") {
      const agent = options.agent?.trim();
      if (!agent) throw new CliError("agent_required", "a claim names the agent taking the work");
      assertMutable(item, "claiming it");
      // Ownership is checked before claimability, so an agent racing for held
      // work is told who holds it rather than that the state is wrong.
      assertClaimable(item, agent);
      // A retrying agent re-claims what it already holds; that is not a second
      // take, so it writes nothing and does not advance the revision.
      if (item.state === "active" && item.claim?.agent === agent) return item;
      const claimed = nextState(item, transition);
      const at = this.stamp();
      this.db.run(
        "UPDATE items SET state = ?, state_reason = NULL, claim_agent = ?, claim_at = ? WHERE id = ?",
        [claimed, agent, at, item.id],
      );
      this.touch(item.id, "claimed", agent, at);
      return this.item(item.id)!;
    }
    const state = nextState(item, transition);
    const reason = requireReason(state, options.reason);
    const at = this.stamp();
    const clearsClaim = transition === "release" || isTerminal(state);
    this.db.run(
      `UPDATE items SET state = ?, state_reason = ?${clearsClaim ? ", claim_agent = NULL, claim_at = NULL" : ""} WHERE id = ?`,
      [state, reason, item.id],
    );
    const detail = [reason, options.note?.trim()].filter(Boolean).join(" — ");
    this.touch(item.id, state === "open" ? "released" : state, detail || null, at);
    return this.item(item.id)!;
  }

  /** Close an item as superseded and record which item took over from it. */
  supersede(
    item: Item,
    successor: Item,
    note: string | undefined,
  ): { item: Item; successor: Item } {
    return this.write(() => {
      if (item.id === successor.id) {
        throw new CliError("self_supersede", "an item cannot supersede itself");
      }
      assertLive(successor, "superseding with it");
      const closed = this.transitionIn(item, "supersede", {
        reason: `superseded by "${successor.label}"`,
        ...(note === undefined ? {} : { note }),
      });
      this.addRelationIn(successor, item, "supersedes", note, "agent");
      return { item: closed, successor: this.item(successor.id)! };
    });
  }

  reorder(ids: readonly string[], placement: Placement): Item[] {
    return this.write(() => {
      const sequence: (Item & Rankable)[] = this.items();
      const next = placeItems(sequence, ids, placement);
      this.applySequence(next);
      const at = this.stamp();
      const labelOf = (id: string) => sequence.find((item) => item.id === id)?.label ?? id;
      const note = describePlacement(placement, labelOf);
      for (const id of ids) this.touch(id, "ordered", note, at);
      return this.items()
        .filter((item) => ids.includes(item.id))
        .sort(bySequence);
    });
  }

  addRelation(
    from: Item,
    to: Item,
    kind: RelationKind,
    note: string | undefined,
    origin: Origin,
  ): Relation {
    return this.write(() => this.addRelationIn(from, to, kind, note, origin));
  }

  addRelationIn(
    from: Item,
    to: Item,
    kind: RelationKind,
    note: string | undefined,
    origin: Origin,
  ): Relation {
    if (from.id === to.id) {
      throw new CliError("self_relation", "an item cannot be related to itself");
    }
    assertLive(from, "relating it");
    assertLive(to, "relating to it");
    const edge = canonicalEdge({ kind, from: from.id, to: to.id });
    const existing = this.relations().find(
      (relation) =>
        relation.kind === edge.kind && relation.from === edge.from && relation.to === edge.to,
    );
    if (existing !== undefined) {
      throw new CliError(
        "duplicate_relation",
        `"${from.label}" and "${to.label}" already carry a ${kind} edge`,
      );
    }
    const labels = new Map(this.items().map((item) => [item.id, item.label]));
    assertAcyclic([...this.liveEdges(), edge], (id) => labels.get(id) ?? id);
    const at = this.stamp();
    this.db.run(
      "INSERT INTO relations (kind, from_id, to_id, note, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [edge.kind, edge.from, edge.to, note?.trim() || null, origin, at],
    );
    const id = (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    const detail = `${kind} "${to.label}"`;
    this.touch(from.id, "related", note?.trim() ? `${detail} — ${note.trim()}` : detail, at);
    this.touch(to.id, "related", `${kind} from "${from.label}"`, at);
    return {
      id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      note: note?.trim() || null,
      origin,
      createdAt: at,
    };
  }

  removeRelation(from: Item, to: Item, kind: RelationKind): Relation {
    return this.write(() => this.removeRelationIn(from, to, kind));
  }

  removeRelationIn(from: Item, to: Item, kind: RelationKind): Relation {
    const edge = canonicalEdge({ kind, from: from.id, to: to.id });
    const existing = this.relations().find(
      (relation) =>
        relation.kind === edge.kind && relation.from === edge.from && relation.to === edge.to,
    );
    if (existing === undefined) {
      throw new CliError(
        "unknown_relation",
        `"${from.label}" and "${to.label}" carry no ${kind} edge`,
        "run `agentboard get` on either item to see the edges it does carry",
      );
    }
    this.db.run("DELETE FROM relations WHERE id = ?", [existing.id]);
    const at = this.stamp();
    this.touch(from.id, "unrelated", `${kind} "${to.label}"`, at);
    this.touch(to.id, "unrelated", `${kind} from "${from.label}"`, at);
    return existing;
  }

  addRef(item: Item, target: string, rel: RefRel): Ref {
    return this.write(() => {
      assertLive(item, "linking it");
      const at = this.stamp();
      const existing = this.refs(item.id).find((ref) => ref.target === target);
      if (existing !== undefined) {
        throw new CliError("duplicate_ref", `"${item.label}" already references ${target}`);
      }
      this.db.run("INSERT INTO refs (item_id, target, rel, created_at) VALUES (?, ?, ?, ?)", [
        item.id,
        target,
        rel,
        at,
      ]);
      const id = (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
      this.touch(item.id, "linked", `${rel}: ${target}`, at);
      return { id, itemId: item.id, target, rel, createdAt: at };
    });
  }

  removeRef(item: Item, target: string): Ref {
    return this.write(() => {
      const existing = this.refs(item.id).find((ref) => ref.target === target);
      if (existing === undefined) {
        throw new CliError(
          "unknown_ref_target",
          `"${item.label}" does not reference ${target}`,
          "run `agentboard get` on the item to see what it references",
        );
      }
      this.db.run("DELETE FROM refs WHERE id = ?", [existing.id]);
      this.touch(item.id, "unlinked", target, this.stamp());
      return existing;
    });
  }

  /**
   * Tombstone. The lifecycle state and the rank are deliberately untouched, so
   * a restore brings the item back exactly as the human left it, in the place
   * they left it — removal never takes an item's priority away.
   */
  remove(item: Item, reason: string): Item {
    return this.write(() => {
      if (item.deletedAt !== null) {
        throw new CliError("already_removed", `"${item.label}" is already removed from the board`);
      }
      const note = reason.trim();
      if (!note) throw new CliError("reason_required", "removing an item requires a reason");
      const at = this.stamp();
      this.db.run("UPDATE items SET deleted_at = ?, deleted_reason = ? WHERE id = ?", [
        at,
        note,
        item.id,
      ]);
      this.touch(item.id, "removed", note, at);
      return this.item(item.id)!;
    });
  }

  restore(item: Item, reason: string | undefined): Item {
    return this.write(() => {
      if (item.deletedAt === null) {
        throw new CliError("not_removed", `"${item.label}" is not removed`);
      }
      const at = this.stamp();
      this.db.run("UPDATE items SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?", [
        item.id,
      ]);
      this.touch(item.id, "restored", reason?.trim() || null, at);
      return this.item(item.id)!;
    });
  }

  recordGrooming(audit: GroomingAudit): void {
    this.db.run(
      `INSERT INTO groomings (draft_id, draft_digest, scope, scope_item_ids, expansions, summary,
         operations, removed_relations, created_bindings, base_revision, result_revision, applied_at, counts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        audit.draftId,
        audit.draftDigest,
        audit.scope,
        audit.scopeItemIds === null ? null : JSON.stringify(audit.scopeItemIds),
        JSON.stringify(audit.expansions),
        audit.summary,
        JSON.stringify(audit.operations),
        JSON.stringify(audit.removedRelations),
        JSON.stringify(audit.created),
        audit.baseRevision,
        audit.resultRevision,
        audit.appliedAt,
        JSON.stringify(audit.counts),
      ],
    );
  }

  isEmpty(): boolean {
    const counts = this.db
      .query(
        "SELECT (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM relations) + (SELECT COUNT(*) FROM groomings) AS n",
      )
      .get() as { n: number };
    return counts.n === 0;
  }

  /** Restore a whole board from an eject file. Only ever into an empty one. */
  importAll(payload: {
    items: Item[];
    events: ItemEvent[];
    relations: Relation[];
    refs: Ref[];
    groomings: GroomingAudit[];
  }): void {
    this.write(() => {
      if (!this.isEmpty()) {
        throw new CliError(
          "board_not_empty",
          "import only ever writes into an empty board, so it cannot merge two histories",
          "point --db at a fresh path, or move the existing board aside first",
        );
      }
      // Ranks are re-densified from the imported sequence rather than trusted:
      // a hand-edited eject file is exactly where a duplicate rank comes from.
      const ordered = [...payload.items].sort(bySequence);
      ordered.forEach((item, rank) => {
        this.db.run(
          `INSERT INTO items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            item.label,
            item.title,
            item.topicKey,
            item.summary,
            item.state,
            item.stateReason,
            item.origin,
            rank,
            item.claim?.agent ?? null,
            item.claim?.at ?? null,
            item.createdAt,
            item.updatedAt,
            item.deletedAt,
            item.deletedReason,
            item.revision,
          ],
        );
        this.setTags(item.id, item.tags);
      });
      for (const event of payload.events) {
        this.db.run(
          "INSERT INTO events (item_id, at, kind, detail, revision) VALUES (?, ?, ?, ?, ?)",
          [event.itemId, event.at, event.kind, event.detail, event.revision],
        );
      }
      for (const relation of payload.relations) {
        this.db.run(
          "INSERT INTO relations (kind, from_id, to_id, note, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            relation.kind,
            relation.from,
            relation.to,
            relation.note,
            relation.origin,
            relation.createdAt,
          ],
        );
      }
      for (const ref of payload.refs) {
        this.db.run("INSERT INTO refs (item_id, target, rel, created_at) VALUES (?, ?, ?, ?)", [
          ref.itemId,
          ref.target,
          ref.rel,
          ref.createdAt,
        ]);
      }
      for (const audit of payload.groomings) this.recordGrooming(audit);
    });
  }
}
