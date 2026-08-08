/**
 * The board's vocabulary. One item type at every granularity — a one-line
 * snippet and a multi-part program are the same record, told apart only by the
 * relations hanging off them.
 */

export const ITEM_STATES = [
  "open",
  "active",
  "waiting",
  "paused",
  "done",
  "superseded",
  "cancelled",
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** Frozen: nothing transitions out of these, so history cannot be rewritten. */
export const TERMINAL_STATES: readonly ItemState[] = ["done", "superseded", "cancelled"];

/** States whose meaning is the reason, so storing one without it says nothing. */
export const REASON_REQUIRED_STATES: readonly ItemState[] = [
  "waiting",
  "paused",
  "cancelled",
  "superseded",
];

export const ORIGINS = ["human", "agent"] as const;
export type Origin = (typeof ORIGINS)[number];

export const RELATION_KINDS = [
  "contains",
  "depends-on",
  "conflicts-with",
  "supersedes",
  "related-to",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** Direction carries no meaning here, so the store keeps one canonical spelling. */
export const SYMMETRIC_RELATION_KINDS: readonly RelationKind[] = ["conflicts-with", "related-to"];

/** Kinds that describe structure; a cycle in any of them is a contradiction. */
export const ACYCLIC_RELATION_KINDS: readonly RelationKind[] = [
  "contains",
  "depends-on",
  "supersedes",
];

export const REF_RELS = ["spec", "notes", "evidence"] as const;
export type RefRel = (typeof REF_RELS)[number];

export interface Claim {
  agent: string;
  at: string;
}

export interface Item {
  id: string;
  /** Short speakable name; the voice surface. */
  label: string;
  /** Readable display variant of the label; defaults from it. */
  title: string;
  /** Normalized label, used to catch a recapture of work already on the board. */
  topicKey: string;
  summary: string | null;
  tags: string[];
  state: ItemState;
  stateReason: string | null;
  origin: Origin;
  /**
   * Place in the one canonical order: a dense, unique, zero-based rank over
   * every row, tombstones and terminal items included. Priority only — it
   * never claims work, changes state, or overrides a `depends-on` edge. One
   * sequence rather than one per bucket is what makes ranks survive a state
   * change and a restore: nothing ever takes an item's rank away.
   */
  rank: number;
  claim: Claim | null;
  createdAt: string;
  updatedAt: string;
  /** Tombstone; state is deliberately untouched so a restore returns it as it was. */
  deletedAt: string | null;
  deletedReason: string | null;
  revision: number;
}

export interface ItemEvent {
  id: number;
  itemId: string;
  at: string;
  kind: string;
  detail: string | null;
  revision: number;
}

export interface Relation {
  id: number;
  kind: RelationKind;
  from: string;
  to: string;
  note: string | null;
  origin: Origin;
  createdAt: string;
}

export interface Ref {
  id: number;
  itemId: string;
  target: string;
  rel: RefRel;
  createdAt: string;
}

export function isTerminal(state: ItemState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isLive(item: Item): boolean {
  return item.deletedAt === null;
}

/** Live and not finished: the set every listing, brief, and ready query starts from. */
export function isOpenWork(item: Item): boolean {
  return item.deletedAt === null && !isTerminal(item.state);
}
