/**
 * Grooming drafts: the only way to reshape the board in bulk.
 *
 * A draft is a reviewed artifact, not a stream of commands. It declares the
 * revision it was built on, the items it is allowed to touch, and every
 * deliberate step outside that scope — then lands completely or not at all.
 * Replaying an identical draft is a no-op that reports the same ids it minted
 * the first time, so an agent that crashed mid-apply retries safely; the same
 * draftId carrying different bytes is a different grooming wearing an applied
 * id, and is refused.
 *
 * Violations are collected rather than thrown one at a time: an agent repairing
 * a draft should see everything wrong with it in one pass.
 */

import { createHash } from "node:crypto";
import { CliError } from "./errors.ts";
import { canonicalEdge, type Edge, edgeKey, findCycle } from "./graph.ts";
import type { Board, GroomingAudit } from "./store.ts";
import { topicKeyFor } from "./topic.ts";
import {
  ACYCLIC_RELATION_KINDS,
  type Item,
  type ItemState,
  isTerminal,
  ORIGINS,
  type Origin,
  RELATION_KINDS,
  type RelationKind,
} from "./types.ts";

export const GROOM_DRAFT_VERSION = 1;
/** A draft is reviewed by a person or an agent; more than this is a bug. */
export const GROOM_OPERATION_LIMIT = 1000;
export const GROOM_TEXT_LIMIT = 20_000;

export const GROOM_CLOSE_STATES = ["done", "superseded", "cancelled"] as const;
export type GroomCloseState = (typeof GROOM_CLOSE_STATES)[number];

/**
 * Kinds that may cross a scope boundary with only one endpoint declared: a
 * dependency or a conflict reaching outside the groomed set is exactly what a
 * scoped grooming must stay able to record. `contains` and `supersedes` restate
 * what the far item *is*, so both ends must be declared.
 */
const CROSS_SCOPE_KINDS: readonly RelationKind[] = ["depends-on", "conflicts-with", "related-to"];

export type GroomOperation =
  | {
      op: "create-item";
      /** Draft-local handle so later operations can name an item with no id yet. */
      tempId: string;
      label: string;
      title?: string;
      summary?: string;
      tags?: string[];
      origin?: Origin;
    }
  | {
      op: "update-item";
      id: string;
      label?: string;
      title?: string;
      summary?: string;
      tags?: string[];
      note?: string;
    }
  | { op: "close-item"; id: string; state: GroomCloseState; reason: string }
  | { op: "add-relation"; kind: RelationKind; from: string; to: string; note?: string }
  | { op: "remove-relation"; kind: RelationKind; from: string; to: string };

export interface GroomDraft {
  version: 1;
  draftId: string;
  /** The exact board revision the draft was built on; anything else is stale. */
  baseRevision: string;
  /** Free-form scope instruction; null means the whole board. */
  scope: string | null;
  /** The resolution of `scope` into exact ids; required whenever scope is set. */
  scopeItemIds?: string[];
  /** Items deliberately touched beyond the declared scope, each with why. */
  expansions?: { id: string; reason: string }[];
  summary: string;
  operations: GroomOperation[];
}

export type GroomOutcome =
  | {
      outcome: "applied";
      draftId: string;
      resultRevision: string;
      counts: GroomCounts;
      created: Binding[];
    }
  | { outcome: "already_applied"; draftId: string; appliedAt: string; created: Binding[] };

export interface Binding {
  tempId: string;
  id: string;
}

export interface GroomCounts {
  created: number;
  updated: number;
  closed: number;
  relationsAdded: number;
  relationsRemoved: number;
}

/**
 * Content identity of a draft. Computed over the normalized draft, so key order
 * and whitespace do not matter but any semantic difference does.
 */
export function groomDraftDigest(draft: GroomDraft): string {
  return `gd1-${createHash("sha256")
    .update(
      JSON.stringify({
        version: draft.version,
        draftId: draft.draftId,
        baseRevision: draft.baseRevision,
        scope: draft.scope,
        scopeItemIds: draft.scopeItemIds ?? null,
        expansions: draft.expansions ?? [],
        summary: draft.summary,
        operations: draft.operations,
      }),
    )
    .digest("hex")}`;
}

// --- Shape parsing ---

const DRAFT_KEYS = new Set([
  "version",
  "draftId",
  "baseRevision",
  "scope",
  "scopeItemIds",
  "expansions",
  "summary",
  "operations",
]);

const OPERATION_KEYS: Record<string, Set<string>> = {
  "create-item": new Set(["op", "tempId", "label", "title", "summary", "tags", "origin"]),
  "update-item": new Set(["op", "id", "label", "title", "summary", "tags", "note"]),
  "close-item": new Set(["op", "id", "state", "reason"]),
  "add-relation": new Set(["op", "kind", "from", "to", "note"]),
  "remove-relation": new Set(["op", "kind", "from", "to"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape-check an untrusted draft. Content legality is `applyGroomDraft`'s job. */
export function parseGroomDraft(value: unknown): { draft: GroomDraft } | { violations: string[] } {
  if (!isRecord(value)) return { violations: ["a draft must be a JSON object"] };
  const violations: string[] = [];
  for (const key of Object.keys(value)) {
    if (!DRAFT_KEYS.has(key)) violations.push(`unknown draft field "${key}"`);
  }
  if (value["version"] !== GROOM_DRAFT_VERSION) violations.push("draft version must be 1");

  const text = (key: string, cap: number): string | null => {
    const raw = value[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      violations.push(`${key} is required and must be a non-empty string`);
      return null;
    }
    if (raw.length > cap) violations.push(`${key} is longer than ${cap} characters`);
    return raw.trim();
  };

  const draftId = text("draftId", 200);
  const baseRevision = text("baseRevision", 200);
  const summary = text("summary", GROOM_TEXT_LIMIT);

  let scope: string | null = null;
  const rawScope = value["scope"];
  if (rawScope === undefined || rawScope === null) {
    scope = null;
  } else if (typeof rawScope !== "string" || rawScope.trim().length === 0) {
    violations.push("scope must be a non-empty string, or null for a whole-board grooming");
  } else {
    if (rawScope.length > GROOM_TEXT_LIMIT) violations.push("scope is too long");
    scope = rawScope.trim();
  }

  let scopeItemIds: string[] | undefined;
  const rawScopeIds = value["scopeItemIds"];
  if (rawScopeIds !== undefined) {
    if (scope === null) {
      violations.push("scopeItemIds only means something alongside a scope instruction");
    } else if (
      !Array.isArray(rawScopeIds) ||
      rawScopeIds.length === 0 ||
      !rawScopeIds.every((id) => typeof id === "string" && id.trim().length > 0)
    ) {
      violations.push("scopeItemIds must be a non-empty array of item ids");
    } else {
      scopeItemIds = rawScopeIds.map((id) => (id as string).trim());
    }
  } else if (scope !== null) {
    violations.push("a scoped grooming must resolve its scope into scopeItemIds");
  }

  let expansions: { id: string; reason: string }[] | undefined;
  const rawExpansions = value["expansions"];
  if (rawExpansions !== undefined) {
    if (scope === null) {
      violations.push("expansions only mean something alongside a scope instruction");
    } else if (!Array.isArray(rawExpansions)) {
      violations.push("expansions must be an array of {id, reason}");
    } else {
      const seen = new Set<string>();
      expansions = [];
      for (const entry of rawExpansions) {
        if (
          !isRecord(entry) ||
          Object.keys(entry).some((key) => key !== "id" && key !== "reason") ||
          typeof entry["id"] !== "string" ||
          entry["id"].trim().length === 0 ||
          typeof entry["reason"] !== "string" ||
          entry["reason"].trim().length === 0
        ) {
          violations.push("every expansion needs a non-blank id and a non-blank reason");
          continue;
        }
        const id = entry["id"].trim();
        if (seen.has(id)) violations.push(`expansions list ${id} twice`);
        if (scopeItemIds?.includes(id)) {
          violations.push(`${id} is already in scopeItemIds; an expansion is beyond the scope`);
        }
        seen.add(id);
        expansions.push({ id, reason: entry["reason"].trim() });
      }
    }
  }

  const rawOperations = value["operations"];
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    violations.push("a draft needs at least one operation");
    return { violations };
  }
  if (rawOperations.length > GROOM_OPERATION_LIMIT) {
    return {
      violations: [`a draft carries at most ${GROOM_OPERATION_LIMIT} operations; split it`],
    };
  }

  const operations: GroomOperation[] = [];
  rawOperations.forEach((raw, index) => {
    const at = index + 1;
    if (!isRecord(raw)) {
      violations.push(`operation ${at} must be an object`);
      return;
    }
    const op = raw["op"];
    if (typeof op !== "string" || OPERATION_KEYS[op] === undefined) {
      violations.push(
        `operation ${at} has an unknown op; one of create-item, update-item, close-item, add-relation, remove-relation`,
      );
      return;
    }
    const allowed = OPERATION_KEYS[op]!;
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) violations.push(`operation ${at} has an unknown field "${key}"`);
    }
    const need = (key: string, cap: number): string | null => {
      const field = raw[key];
      if (typeof field !== "string" || field.trim().length === 0) {
        violations.push(`operation ${at} (${op}) needs a non-blank ${key}`);
        return null;
      }
      if (field.length > cap) violations.push(`operation ${at} (${op}) has an over-long ${key}`);
      return field.trim();
    };
    const maybe = (key: string, cap: number): string | undefined => {
      const field = raw[key];
      if (field === undefined) return undefined;
      if (typeof field !== "string") {
        violations.push(`operation ${at} (${op}) has a non-string ${key}`);
        return undefined;
      }
      if (field.length > cap) violations.push(`operation ${at} (${op}) has an over-long ${key}`);
      return field.trim();
    };
    const maybeTags = (): string[] | undefined => {
      const field = raw["tags"];
      if (field === undefined) return undefined;
      if (!Array.isArray(field) || !field.every((tag) => typeof tag === "string")) {
        violations.push(`operation ${at} (${op}) has non-string tags`);
        return undefined;
      }
      return field.map((tag) => (tag as string).trim().toLowerCase()).filter(Boolean);
    };

    switch (op) {
      case "create-item": {
        const tempId = need("tempId", 200);
        const label = need("label", 500);
        const origin = raw["origin"];
        if (origin !== undefined && !ORIGINS.includes(origin as Origin)) {
          violations.push(
            `operation ${at} (create-item) has an origin outside ${ORIGINS.join(", ")}`,
          );
        }
        const title = maybe("title", 500);
        const summaryText = maybe("summary", GROOM_TEXT_LIMIT);
        const tags = maybeTags();
        if (tempId !== null && label !== null) {
          operations.push({
            op,
            tempId,
            label,
            ...(title === undefined ? {} : { title }),
            ...(summaryText === undefined ? {} : { summary: summaryText }),
            ...(tags === undefined ? {} : { tags }),
            ...(origin === undefined ? {} : { origin: origin as Origin }),
          });
        }
        break;
      }
      case "update-item": {
        const id = need("id", 500);
        const label = maybe("label", 500);
        const title = maybe("title", 500);
        const summaryText = maybe("summary", GROOM_TEXT_LIMIT);
        const tags = maybeTags();
        const note = maybe("note", GROOM_TEXT_LIMIT);
        if (
          label === undefined &&
          title === undefined &&
          summaryText === undefined &&
          tags === undefined &&
          note === undefined
        ) {
          violations.push(`operation ${at} (update-item) changes nothing`);
        }
        if (id !== null) {
          operations.push({
            op,
            id,
            ...(label === undefined ? {} : { label }),
            ...(title === undefined ? {} : { title }),
            ...(summaryText === undefined ? {} : { summary: summaryText }),
            ...(tags === undefined ? {} : { tags }),
            ...(note === undefined ? {} : { note }),
          });
        }
        break;
      }
      case "close-item": {
        const id = need("id", 500);
        const reason = need("reason", GROOM_TEXT_LIMIT);
        const state = raw["state"];
        if (!GROOM_CLOSE_STATES.includes(state as GroomCloseState)) {
          violations.push(
            `operation ${at} (close-item) needs a state of ${GROOM_CLOSE_STATES.join(", ")}`,
          );
          break;
        }
        if (id !== null && reason !== null) {
          operations.push({ op, id, state: state as GroomCloseState, reason });
        }
        break;
      }
      case "add-relation":
      case "remove-relation": {
        const kind = raw["kind"];
        const from = need("from", 500);
        const to = need("to", 500);
        if (!RELATION_KINDS.includes(kind as RelationKind)) {
          violations.push(`operation ${at} (${op}) needs a kind of ${RELATION_KINDS.join(", ")}`);
          break;
        }
        const note = op === "add-relation" ? maybe("note", GROOM_TEXT_LIMIT) : undefined;
        if (from !== null && to !== null) {
          operations.push(
            op === "add-relation"
              ? {
                  op,
                  kind: kind as RelationKind,
                  from,
                  to,
                  ...(note === undefined ? {} : { note }),
                }
              : { op, kind: kind as RelationKind, from, to },
          );
        }
        break;
      }
    }
  });

  if (violations.length > 0) return { violations };
  return {
    draft: {
      version: GROOM_DRAFT_VERSION,
      draftId: draftId!,
      baseRevision: baseRevision!,
      scope,
      ...(scopeItemIds === undefined ? {} : { scopeItemIds }),
      ...(expansions === undefined ? {} : { expansions }),
      summary: summary!,
      operations,
    },
  };
}

// --- Export ---

export interface GroomExport {
  version: 1;
  baseRevision: string;
  generatedAt: string;
  items: {
    id: string;
    label: string;
    title: string;
    topicKey: string;
    summary: string | null;
    tags: string[];
    state: string;
    stateReason: string | null;
    origin: Origin;
    rank: number;
    claim: { agent: string; at: string } | null;
  }[];
  relations: { kind: RelationKind; from: string; to: string; note: string | null }[];
}

/** What a groomer reads. Removed items are omitted: grooming never touches them. */
export function buildGroomExport(board: Board): GroomExport {
  const live = board.liveItems();
  return {
    version: GROOM_DRAFT_VERSION,
    baseRevision: board.revision(),
    generatedAt: board.stamp(),
    items: live.map((item) => ({
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
    })),
    relations: board
      .relations()
      .filter(
        (relation) =>
          live.some((item) => item.id === relation.from) &&
          live.some((item) => item.id === relation.to),
      )
      .map((relation) => ({
        kind: relation.kind,
        from: relation.from,
        to: relation.to,
        note: relation.note,
      })),
  };
}

// --- Apply ---

interface SimItem {
  id: string;
  label: string;
  topicKey: string;
  state: ItemState;
  deleted: boolean;
  created: boolean;
}

export function applyGroomDraft(board: Board, draft: GroomDraft): GroomOutcome {
  return board.write(() => {
    const applied = board.grooming(draft.draftId);
    if (applied !== null) {
      if (applied.draftDigest !== groomDraftDigest(draft)) {
        throw new CliError(
          "draft_conflict",
          `draft ${draft.draftId} was already applied at ${applied.appliedAt} with different content`,
          "a changed draft is a new grooming: give it a new draftId",
        );
      }
      return {
        outcome: "already_applied" as const,
        draftId: draft.draftId,
        appliedAt: applied.appliedAt,
        created: applied.created,
      };
    }

    const baseRevision = board.revision();
    if (draft.baseRevision !== baseRevision) {
      throw new CliError(
        "stale_draft",
        `the board moved since this draft was built (it was built on ${draft.baseRevision})`,
        "re-run `agentboard groom export` and rebuild the draft against the current board",
      );
    }

    const items = board.items();
    const violations: string[] = [];
    const sim = new Map<string, SimItem>(
      items.map((item) => [
        item.id,
        {
          id: item.id,
          label: item.label,
          topicKey: item.topicKey,
          state: item.state,
          deleted: item.deletedAt !== null,
          created: false,
        },
      ]),
    );
    const edges = new Map<string, Edge>(
      board.relations().map((relation) => {
        const edge = { kind: relation.kind, from: relation.from, to: relation.to };
        return [edgeKey(edge), edge];
      }),
    );

    // Scope resolution happens before any operation is judged, so an operation
    // is never called out-of-scope because the scope itself was malformed.
    const scopeSet = new Set<string>();
    if (draft.scope !== null) {
      for (const id of draft.scopeItemIds ?? []) {
        const target = sim.get(id);
        if (target === undefined) violations.push(`scopeItemIds names an unknown item: ${id}`);
        else if (target.deleted) violations.push(`scopeItemIds names a removed item: ${id}`);
        else scopeSet.add(id);
      }
      for (const expansion of draft.expansions ?? []) {
        const target = sim.get(expansion.id);
        if (target === undefined)
          violations.push(`expansions names an unknown item: ${expansion.id}`);
        else if (target.deleted)
          violations.push(`expansions names a removed item: ${expansion.id}`);
        else scopeSet.add(expansion.id);
      }
    }

    const tempIds = new Map<string, string>();
    const inScope = (id: string): boolean =>
      draft.scope === null || scopeSet.has(id) || sim.get(id)?.created === true;

    const resolve = (raw: string, at: number, op: string): SimItem | null => {
      const id = tempIds.get(raw) ?? raw;
      const target = sim.get(id);
      if (target === undefined) {
        violations.push(`operation ${at} (${op}) names an unknown item: ${raw}`);
        return null;
      }
      if (target.deleted) {
        violations.push(
          `operation ${at} (${op}) names "${target.label}", which was removed from the board; grooming never touches removed items`,
        );
        return null;
      }
      return target;
    };

    const closedAsSuperseded = new Set<string>();
    const addedSupersedes: { from: string; to: string; at: number }[] = [];
    const removedSupersedes: { from: string; to: string; at: number }[] = [];

    draft.operations.forEach((operation, index) => {
      const at = index + 1;
      switch (operation.op) {
        case "create-item": {
          if (tempIds.has(operation.tempId)) {
            violations.push(`operation ${at} (create-item) reuses tempId ${operation.tempId}`);
            break;
          }
          if (sim.has(operation.tempId)) {
            violations.push(
              `operation ${at} (create-item) has a tempId that collides with an item id`,
            );
            break;
          }
          const topicKey = topicKeyFor(operation.label);
          const clash = [...sim.values()].find(
            (candidate) =>
              candidate.topicKey === topicKey && !candidate.deleted && !isTerminal(candidate.state),
          );
          if (clash !== undefined) {
            violations.push(
              `operation ${at} (create-item) would duplicate "${clash.label}" (${clash.id}), which is already open on that topic`,
            );
            break;
          }
          const placeholder = `temp:${operation.tempId}`;
          tempIds.set(operation.tempId, placeholder);
          sim.set(placeholder, {
            id: placeholder,
            label: operation.label,
            topicKey,
            state: "open",
            deleted: false,
            created: true,
          });
          break;
        }
        case "update-item": {
          const target = resolve(operation.id, at, "update-item");
          if (target === null) break;
          if (!inScope(target.id)) {
            violations.push(
              `operation ${at} (update-item) touches "${target.label}", which is outside the declared scope`,
            );
          }
          if (isTerminal(target.state)) {
            violations.push(
              `operation ${at} (update-item) touches "${target.label}", which is ${target.state}; grooming reshapes open items only`,
            );
          }
          if (operation.label !== undefined) {
            target.label = operation.label;
            target.topicKey = topicKeyFor(operation.label);
          }
          break;
        }
        case "close-item": {
          const target = resolve(operation.id, at, "close-item");
          if (target === null) break;
          if (!inScope(target.id)) {
            violations.push(
              `operation ${at} (close-item) closes "${target.label}", which is outside the declared scope`,
            );
          }
          if (isTerminal(target.state)) {
            violations.push(
              `operation ${at} (close-item) closes "${target.label}", which is already ${target.state}`,
            );
            break;
          }
          target.state = operation.state;
          if (operation.state === "superseded") closedAsSuperseded.add(target.id);
          break;
        }
        case "add-relation": {
          const from = resolve(operation.from, at, "add-relation");
          const to = resolve(operation.to, at, "add-relation");
          if (from === null || to === null) break;
          if (from.id === to.id) {
            violations.push(`operation ${at} (add-relation) relates an item to itself`);
            break;
          }
          const declared = [from.id, to.id].filter((id) => inScope(id)).length;
          const needed = CROSS_SCOPE_KINDS.includes(operation.kind) ? 1 : 2;
          if (draft.scope !== null && declared < needed) {
            violations.push(
              `operation ${at} (add-relation) needs ${needed === 1 ? "an endpoint" : "both endpoints"} inside the declared scope`,
            );
          }
          const edge = canonicalEdge({ kind: operation.kind, from: from.id, to: to.id });
          const key = edgeKey(edge);
          if (edges.has(key)) {
            violations.push(
              `operation ${at} (add-relation) restates an edge "${from.label}" and "${to.label}" already carry`,
            );
            break;
          }
          edges.set(key, edge);
          if (operation.kind === "supersedes")
            addedSupersedes.push({ from: from.id, to: to.id, at });
          break;
        }
        case "remove-relation": {
          const from = resolve(operation.from, at, "remove-relation");
          const to = resolve(operation.to, at, "remove-relation");
          if (from === null || to === null) break;
          if (draft.scope !== null && (!inScope(from.id) || !inScope(to.id))) {
            violations.push(
              `operation ${at} (remove-relation) needs both endpoints inside the declared scope; removing an edge restructures both ends`,
            );
          }
          const key = edgeKey(canonicalEdge({ kind: operation.kind, from: from.id, to: to.id }));
          if (!edges.has(key)) {
            violations.push(
              `operation ${at} (remove-relation) removes an edge "${from.label}" and "${to.label}" do not carry`,
            );
            break;
          }
          edges.delete(key);
          if (operation.kind === "supersedes")
            removedSupersedes.push({ from: from.id, to: to.id, at });
          break;
        }
      }
    });

    if (violations.length === 0) {
      const finalEdges = [...edges.values()];
      for (const kind of ACYCLIC_RELATION_KINDS) {
        const cycle = findCycle(finalEdges, kind);
        if (cycle !== null) {
          violations.push(
            `the draft closes a ${kind} loop: ${cycle.map((id) => `"${sim.get(id)?.label ?? id}"`).join(" → ")}`,
          );
        }
      }
      for (const id of closedAsSuperseded) {
        const hasSuccessor = finalEdges.some(
          (edge) => edge.kind === "supersedes" && edge.to === id,
        );
        if (!hasSuccessor) {
          violations.push(
            `"${sim.get(id)?.label ?? id}" is closed as superseded but nothing supersedes it; add the edge or close it as done or cancelled`,
          );
        }
      }
      for (const edge of addedSupersedes) {
        const target = sim.get(edge.to);
        if (target !== undefined && !isTerminal(target.state)) {
          violations.push(
            `operation ${edge.at} (add-relation) supersedes "${target.label}", which the draft leaves open; close it as superseded in the same draft`,
          );
        }
      }
      for (const edge of removedSupersedes) {
        const target = sim.get(edge.to);
        if (target === undefined || target.state !== "superseded") continue;
        if (
          !finalEdges.some(
            (candidate) => candidate.kind === "supersedes" && candidate.to === edge.to,
          )
        ) {
          violations.push(
            `operation ${edge.at} (remove-relation) would leave "${target.label}" superseded by nothing`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new CliError(
        "groom_refused",
        `the draft was refused; nothing was written:\n${violations.map((line) => `  - ${line}`).join("\n")}`,
        "fix the operations and apply the same draftId again, or re-export if the board has moved",
      );
    }

    // --- Commit. Validation passed against this exact snapshot, and the
    // transaction is already held, so nothing below can be refused. ---

    const bindings: Binding[] = [];
    const realId = new Map<string, string>();
    const counts: GroomCounts = {
      created: 0,
      updated: 0,
      closed: 0,
      relationsAdded: 0,
      relationsRemoved: 0,
    };
    const removedRelations: GroomingAudit["removedRelations"] = [];
    const lookup = (raw: string): Item => {
      const id = realId.get(raw) ?? raw;
      const item = board.item(id);
      if (item === null) throw new CliError("write_failed", `item vanished mid-grooming: ${raw}`);
      return item;
    };

    for (const operation of draft.operations) {
      switch (operation.op) {
        case "create-item": {
          const created = board.addItemIn({
            label: operation.label,
            ...(operation.title === undefined ? {} : { title: operation.title }),
            ...(operation.summary === undefined ? {} : { summary: operation.summary }),
            ...(operation.tags === undefined ? {} : { tags: operation.tags }),
            origin: operation.origin ?? "agent",
            allowDuplicateTopic: true,
          });
          realId.set(operation.tempId, created.id);
          bindings.push({ tempId: operation.tempId, id: created.id });
          counts.created++;
          break;
        }
        case "update-item": {
          board.updateItemIn(lookup(operation.id), {
            ...(operation.label === undefined ? {} : { label: operation.label }),
            ...(operation.title === undefined ? {} : { title: operation.title }),
            ...(operation.summary === undefined ? {} : { summary: operation.summary }),
            ...(operation.tags === undefined ? {} : { tags: operation.tags }),
            ...(operation.note === undefined ? {} : { note: operation.note }),
          });
          counts.updated++;
          break;
        }
        case "close-item": {
          const transition =
            operation.state === "done"
              ? "done"
              : operation.state === "cancelled"
                ? "cancel"
                : "supersede";
          board.transitionIn(lookup(operation.id), transition, { reason: operation.reason });
          counts.closed++;
          break;
        }
        case "add-relation": {
          board.addRelationIn(
            lookup(operation.from),
            lookup(operation.to),
            operation.kind,
            operation.note,
            "agent",
          );
          counts.relationsAdded++;
          break;
        }
        case "remove-relation": {
          removedRelations.push(
            board.removeRelationIn(lookup(operation.from), lookup(operation.to), operation.kind),
          );
          counts.relationsRemoved++;
          break;
        }
      }
    }

    const appliedAt = board.stamp();
    const resultRevision = board.revision();
    board.recordGrooming({
      draftId: draft.draftId,
      draftDigest: groomDraftDigest(draft),
      scope: draft.scope,
      scopeItemIds: draft.scopeItemIds ?? null,
      expansions: draft.expansions ?? [],
      summary: draft.summary,
      operations: draft.operations,
      removedRelations,
      created: bindings,
      baseRevision,
      resultRevision,
      appliedAt,
      counts: { ...counts },
    });
    return {
      outcome: "applied" as const,
      draftId: draft.draftId,
      resultRevision,
      counts,
      created: bindings,
    };
  });
}
