/**
 * The one authored description of this CLI: the fleet agent contract, version
 * 1 (agentstart/config/agent-contract/schema.json).
 *
 * `guide --json` emits this document. `--help`, `--agent-help`, and
 * `--agent-teaser` are RENDERS of it (help.ts), and every command's flag
 * grammar is DERIVED from it (cli.ts). Nothing about the command surface is
 * written twice: a command's summary, its flags, their choices and defaults,
 * and the judgment about whether it writes all live here once.
 */

import { GROOM_CLOSE_STATES, GROOM_OPERATION_LIMIT } from "./groom.ts";
import { PLACEMENTS } from "./order.ts";
import { MATCH_TIERS } from "./resolve.ts";
import { BOARD_SCHEMA_VERSION } from "./schema.ts";
import {
  ITEM_STATES,
  ORIGINS,
  REASON_REQUIRED_STATES,
  REF_RELS,
  RELATION_KINDS,
  TERMINAL_STATES,
} from "./types.ts";

export const VERSION = "0.1.0";

/** The contract document's own version, independent of the envelope's. */
export const CONTRACT_VERSION = 1;

export type ArgumentType = "string" | "boolean" | "integer" | "number";

export interface ContractArgument {
  name: string;
  type: ArgumentType;
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  direction?: "in" | "out";
  required?: boolean;
  positional?: boolean;
  repeatable?: boolean;
  choices?: string[];
  default?: unknown;
  aliases?: string[];
}

export interface ContractConstraint {
  kind: "one_of" | "conflicts" | "requires";
  arguments: string[];
  required?: boolean;
  description?: string;
}

export interface ContractCommand {
  name: string;
  summary: string;
  audience: "agent" | "operator" | "internal";
  mutates?: boolean;
  guidance?: string;
  arguments?: ContractArgument[];
  constraints?: ContractConstraint[];
  subcommands?: ContractCommand[];
}

// --- Reusable argument shapes ---

const ref = (name: string, what: string): ContractArgument => ({
  name,
  type: "string",
  description: what,
  positional: true,
  required: true,
  format: "ref",
});

const note: ContractArgument = {
  name: "--note",
  type: "string",
  description: "A line recorded on the event this writes.",
};

const reason = (what: string): ContractArgument => ({
  name: "--reason",
  type: "string",
  description: what,
  required: true,
});

const REF_TARGET_ARGUMENTS: ContractArgument[] = [
  { name: "--wiki", type: "string", description: "An agentwiki page slug." },
  { name: "--url", type: "string", description: "An http or https URL.", format: "url" },
  { name: "--artifact", type: "string", description: "A published artifact name." },
];

const REF_TARGET_CONSTRAINT: ContractConstraint = {
  kind: "one_of",
  arguments: ["--wiki", "--url", "--artifact"],
  required: true,
  description: "A reference names exactly one outward target.",
};

// --- Global arguments ---

/**
 * Accepted by every command, before or after the command name. Declared once;
 * a consumer building a call surface should suppress them.
 */
export const GLOBAL_ARGUMENTS: ContractArgument[] = [
  {
    name: "--json",
    type: "boolean",
    description:
      "Emit the stable {schema_version, ok, error, data} envelope. Preferred for agents.",
  },
  {
    name: "--jsonl",
    type: "boolean",
    description:
      "Emit one record per line where a command streams: list, search, ready, events, resolve, graph, export.",
  },
  {
    name: "--db",
    type: "string",
    description:
      "Board database; outranks AGENTBOARD_DB and the default path (~/.local/share/agentboard/board.sqlite3).",
    format: "path",
    direction: "in",
  },
  {
    name: "--help",
    type: "boolean",
    description: "Print this command's help instead of running it. Never opens the board.",
    aliases: ["-h"],
  },
];

/**
 * Recognized only before a command name, so they are not global arguments and
 * have no place in the contract — but `--help` still has to print them.
 */
export const ENTRYPOINT_FLAGS: { flag: string; meaning: string }[] = [
  { flag: "--version, -V", meaning: "Show the version" },
  { flag: "--agent-help", meaning: "Show the agent runbook" },
  { flag: "--agent-teaser", meaning: "Show a one-line capability summary" },
];

// --- Commands ---

export const COMMANDS: ContractCommand[] = [
  {
    name: "add",
    summary: "Capture an item from spoken words",
    audience: "agent",
    mutates: true,
    arguments: [
      {
        name: "label",
        type: "string",
        description:
          "The short speakable name, taken from every positional word; the voice surface and the source of the topic key.",
        positional: true,
        required: true,
      },
      {
        name: "--title",
        type: "string",
        description: "Readable display name; defaults from the label.",
      },
      { name: "--summary", type: "string", description: "Longer description of the work." },
      {
        name: "--tag",
        type: "string",
        description: "Comma-joined tags in one value, not a repeated flag.",
      },
      {
        name: "--origin",
        type: "string",
        description: "Who asked for the item.",
        choices: [...ORIGINS],
        default: "human",
      },
      {
        name: "--new",
        type: "boolean",
        description: "Capture even though an open item already holds this topic.",
      },
    ],
    guidance: `A label whose topic key matches an item already open is refused with
existing_topic, naming the match — that refusal is the point. Pass --new only
when a second item is genuinely wanted.

Examples:
  agentboard add the auth cleanup --tag auth,security
  agentboard add fix the flaky login test --summary "fails ~1 in 20 on CI" --json`,
  },
  {
    name: "edit",
    summary: "Reword one item's label, title, or summary",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item to reword."),
      {
        name: "--label",
        type: "string",
        description: "New speakable label; recomputes the topic key.",
      },
      { name: "--title", type: "string", description: "New display title." },
      { name: "--summary", type: "string", description: "New description." },
    ],
    guidance: `At least one of --label, --title, or --summary is required, and any combination
may be given together. A rename recomputes the topic key, so renaming onto a
topic another open item already holds is refused with existing_topic — supersede
or relate the two instead. Terminal and removed items refuse the edit.

This is the single-item path; reshaping several items at once is a grooming
draft, which is the only bulk-mutation path.

Examples:
  agentboard edit "the auth cleanup" --label "the token rotation"
  agentboard edit it-9f2a41bc --summary "fails ~1 in 20 on CI" --json`,
  },
  {
    name: "get",
    summary: "Show one item with its relations, refs, and blockers",
    audience: "agent",
    mutates: false,
    arguments: [ref("ref", "The item to show.")],
    guidance:
      "Shows state, order, claim, tags, summary, every relation, every outward ref, and the unfinished blockers keeping the item out of ready.",
  },
  {
    name: "list",
    summary: "List the board in order, filtered by state or tag",
    audience: "agent",
    mutates: false,
    arguments: [
      {
        name: "--state",
        type: "string",
        description: "Select exactly one state, terminal states included.",
        choices: [...ITEM_STATES],
      },
      { name: "--tag", type: "string", description: "Keep only items carrying this tag." },
      {
        name: "--all",
        type: "boolean",
        description: "Include finished items. Ignored when --state already names a state.",
      },
    ],
    guidance:
      "Default: live and unfinished, in board order. The listing is the one rank sequence, filtered — never re-sorted.",
  },
  {
    name: "search",
    summary: "Find items whose label, title, summary, or tags match",
    audience: "agent",
    mutates: false,
    arguments: [
      {
        name: "query",
        type: "string",
        description: "Substring to match, case-insensitively, over live items.",
        positional: true,
        required: true,
      },
    ],
  },
  {
    name: "events",
    summary: "Show one item's append-only event log",
    audience: "agent",
    mutates: false,
    arguments: [ref("ref", "The item whose history to print.")],
    guidance: "Every mutation appends here and bumps the item's revision; nothing is rewritten.",
  },
  {
    name: "resolve",
    summary: "Rank the items a spoken phrase could name",
    audience: "agent",
    mutates: false,
    arguments: [
      {
        name: "phrase",
        type: "string",
        description: "The words to resolve, taken from every positional word.",
        positional: true,
        required: true,
      },
    ],
    guidance:
      "Ranked candidates with the tier that matched: id, label, topic, or contains. Reach for this instead of guessing between two items.",
  },
  {
    name: "ready",
    summary: "List open items with no unfinished blockers, in order",
    audience: "agent",
    mutates: false,
    arguments: [],
    guidance:
      "Ready is computed on every call from the depends-on edges, never stored, so it cannot go stale. Start here when picking up work.",
  },
  {
    name: "claim",
    summary: "Take an item atomically for one agent",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item to take."),
      {
        name: "--agent",
        type: "string",
        description: "The name of the agent taking the work.",
        required: true,
      },
    ],
    guidance:
      "Atomic: the write transaction takes the lock before reading, so two agents racing for one item cannot both win. A second agent is refused with already_claimed rather than queued; re-claiming as the same agent is idempotent. Only open work is claimable — resume a waiting or paused item first.",
  },
  {
    name: "release",
    summary: "Give a claimed item back to the board",
    audience: "agent",
    mutates: true,
    arguments: [ref("ref", "The claimed item to give back.")],
    guidance: "Clears the claim and returns the item to open, wherever it sat. Its rank is kept.",
  },
  {
    name: "done",
    summary: "Close an item as finished",
    audience: "agent",
    mutates: true,
    arguments: [ref("ref", "The item to finish."), note],
  },
  {
    name: "cancel",
    summary: "Close an item as cancelled, with a reason",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item to cancel."),
      reason("Why it is being cancelled; the reason is the whole content of that state."),
    ],
  },
  {
    name: "supersede",
    summary: "Close an item as superseded by another",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item being taken over from."),
      {
        name: "--by",
        type: "string",
        description: "The successor item.",
        required: true,
        format: "ref",
      },
      note,
    ],
    guidance:
      "Closes the first item as superseded and records a supersedes edge from the successor to it.",
  },
  {
    name: "wait",
    summary: "Park an item on something outside the board",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item to park."),
      reason("What it is waiting on; the reason is the whole content of that state."),
    ],
    guidance:
      "A dependency on another item is a depends-on relation instead — that is what ready computes from. The claim is kept.",
  },
  {
    name: "pause",
    summary: "Set an item aside deliberately",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item to set aside."),
      reason("Why it is being set aside; the reason is the whole content of that state."),
    ],
    guidance: "Pausing is about attention, not priority: the item keeps its rank and its claim.",
  },
  {
    name: "resume",
    summary: "Bring a waiting or paused item back",
    audience: "agent",
    mutates: true,
    arguments: [ref("ref", "The waiting or paused item.")],
    guidance: "Returns to active when the item is still claimed, else to open.",
  },
  {
    name: "order",
    summary: "Move items to one place in the board's order",
    audience: "agent",
    mutates: true,
    arguments: [
      {
        name: "anchor",
        type: "string",
        description:
          "The item to land behind. Required with --to after, and meaningless with the other placements.",
        positional: true,
        format: "ref",
      },
      {
        name: "--id",
        type: "string",
        description:
          "Comma-joined refs in one value, not a repeated flag. The dictated sequence is preserved exactly.",
        required: true,
      },
      {
        name: "--to",
        type: "string",
        description: "Where the moved run lands.",
        choices: [...PLACEMENTS],
        required: true,
      },
    ],
    guidance: `One dictated run of work is one call. "next" lands behind *every* item already
underway — every claimed (active) item, not merely the first — so reprioritizing
what comes next never displaces work another agent is holding; with nothing
underway it is the same as "first". Order is priority and nothing else: it never
claims work, changes a state, or overrides a depends-on edge.

Examples:
  agentboard order --id "the auth cleanup,the log panel" --to next
  agentboard order --id it-9f2a41bc --to after "the auth cleanup"`,
  },
  {
    name: "relate",
    summary: "Add a typed edge between two items",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("from", "The item the edge leaves."),
      {
        name: "kind",
        type: "string",
        description: "The edge kind.",
        positional: true,
        required: true,
        choices: [...RELATION_KINDS],
      },
      ref("to", "The item the edge points at."),
      note,
    ],
    guidance:
      "conflicts-with and related-to read the same either way and dedupe regardless of direction. contains, depends-on, and supersedes are validated acyclic on write.",
  },
  {
    name: "unrelate",
    summary: "Remove a typed edge between two items",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("from", "The item the edge leaves."),
      {
        name: "kind",
        type: "string",
        description: "The edge kind to remove.",
        positional: true,
        required: true,
        choices: [...RELATION_KINDS],
      },
      ref("to", "The item the edge points at."),
    ],
  },
  {
    name: "link",
    summary: "Reference a wiki page, artifact, or URL from an item",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The item that gains the reference."),
      ...REF_TARGET_ARGUMENTS,
      {
        name: "--rel",
        type: "string",
        description: "What the reference is to the item.",
        choices: [...REF_RELS],
        default: "notes",
      },
    ],
    constraints: [REF_TARGET_CONSTRAINT],
    guidance: "Refs point outward at other systems; relations point at other items.",
  },
  {
    name: "unlink",
    summary: "Drop one of an item's outward references",
    audience: "agent",
    mutates: true,
    arguments: [ref("ref", "The item that loses the reference."), ...REF_TARGET_ARGUMENTS],
    constraints: [REF_TARGET_CONSTRAINT],
  },
  {
    name: "tree",
    summary: "Show the containment forest",
    audience: "agent",
    mutates: false,
    arguments: [
      {
        name: "--root",
        type: "string",
        description: "Show only the subtree under this item.",
        format: "ref",
      },
    ],
  },
  {
    name: "graph",
    summary: "Export every node and edge as JSON",
    audience: "agent",
    mutates: false,
    arguments: [],
  },
  {
    name: "brief",
    summary: "Summarize the board, read or spoken",
    audience: "agent",
    mutates: false,
    arguments: [
      {
        name: "--spoken",
        type: "boolean",
        description:
          "Render speakable prose: labels only, never ids, hashes, or paths. Every live unfinished item produces a line, so silence means the board is empty.",
      },
    ],
    guidance: "Grouped summary: underway, ready, blocked, waiting, paused.",
  },
  {
    name: "state",
    summary: "The budget-capped bearings dump for agents",
    audience: "agent",
    mutates: false,
    arguments: [
      {
        name: "--budget",
        type: "integer",
        description: "Approximate tokens (~4 characters each); at least 60.",
        default: 400,
      },
    ],
    guidance:
      "A counts header that accounts for everything open, label-only lines for what fits the budget, (+N more) for what does not, and no output at all when the board is clear — silence is the all-clear. Distinct from an item's state: this is bearings for a re-orienting agent. Reading the board in full is brief; acting on it is ready and claim.",
  },
  {
    name: "groom",
    summary: "Export a grooming draft, or apply one atomically",
    audience: "agent",
    subcommands: [
      {
        name: "export",
        summary: "Export the live board as the base for a draft",
        audience: "agent",
        mutates: false,
        arguments: [
          {
            name: "--out",
            type: "string",
            description: "Write the draft base here instead of to stdout.",
            format: "path",
            direction: "out",
          },
        ],
        guidance:
          "Gives {version, baseRevision, generatedAt, items, relations}. baseRevision is the revision the draft must be built on.",
      },
      {
        name: "apply",
        summary: "Apply a grooming draft atomically",
        audience: "agent",
        mutates: true,
        arguments: [
          {
            name: "draft",
            type: "string",
            description: "The draft file. There is no stdin path: name a file.",
            positional: true,
            required: true,
            format: "path",
            direction: "in",
          },
        ],
        guidance: `Five operations: create-item, update-item, close-item, add-relation,
remove-relation, at most ${GROOM_OPERATION_LIMIT} of them. tempIds let one draft reference the items
it creates. Atomic: it lands completely or writes nothing. Replaying the same
draftId with identical bytes reports already_applied and changes nothing;
different bytes are refused as draft_conflict; a moved board is refused as
stale_draft (re-export). Declare scopeItemIds when the draft is scoped, and
expansions for anything touched beyond it.`,
      },
    ],
  },
  {
    name: "rm",
    summary: "Tombstone an item, keeping its rank and history",
    audience: "agent",
    mutates: true,
    arguments: [ref("ref", "The item to tombstone."), reason("Why it is leaving the board.")],
    guidance:
      "Nothing is erased: the state, the rank, and the event log are all kept, and the item simply stops being visible to every operational reader.",
  },
  {
    name: "restore",
    summary: "Bring a removed item back to the rank it held",
    audience: "agent",
    mutates: true,
    arguments: [
      ref("ref", "The tombstoned item."),
      { name: "--reason", type: "string", description: "Why it is coming back." },
    ],
  },
  {
    name: "guide",
    summary: "Print this contract: the machine-readable description of the CLI",
    audience: "agent",
    mutates: false,
    arguments: [],
    guidance:
      "Needs no database and will not conjure one, so it is always safe. --help, --agent-help, and --agent-teaser are renders of this document.",
  },
  {
    name: "export",
    summary: "Eject the whole board as JSONL",
    audience: "operator",
    mutates: true,
    arguments: [
      {
        name: "--out",
        type: "string",
        description: "Write here instead of to stdout. An existing file is overwritten.",
        format: "path",
        direction: "out",
      },
    ],
    guidance:
      "Full fidelity: items including tombstones, events, relations, refs, and the grooming audit. The hedge against this schema — everything can leave. It writes no board state, but with --out it writes a file, so it is not read-only.",
  },
  {
    name: "import",
    summary: "Load an ejected board into an empty database",
    audience: "operator",
    mutates: true,
    arguments: [
      {
        name: "file",
        type: "string",
        description: "The ejected JSONL file.",
        positional: true,
        required: true,
        format: "path",
        direction: "in",
      },
    ],
    guidance:
      "Only ever writes into an empty board, so it can never merge two histories. An ejected line is hand-editable, so every enum is re-checked on the way in.",
  },
  {
    name: "render",
    summary: "Write a self-contained HTML snapshot of the board",
    audience: "operator",
    mutates: true,
    arguments: [
      {
        name: "--out",
        type: "string",
        description:
          "Destination file; defaults to agentboard.html in the working directory. An existing file is overwritten.",
        format: "path",
        direction: "out",
      },
      {
        name: "--publish",
        type: "boolean",
        description: "Hand the snapshot to `agentwiki publish` and report its data as `published`.",
      },
    ],
    guidance:
      "Kanban columns by state plus the containment tree, in one file. Without --out a publish goes through a temp file that is removed once the artifact store owns the bytes, so nothing is left in the working directory (a failed publish keeps the file the recovery command names). agentboard never runs an HTTP server.",
  },
];

// --- The conceptual layer ---

const GUIDANCE = `One item type at every granularity. Relations, not a second type, are what make
one item a program and another a one-liner. Ids are opaque: pass a label or any
unambiguous phrase wherever a command takes <ref>.

Reading (safe anytime)
  agentboard ready --json                 Open items with no unfinished blockers,
                                          in board order. Start here.
  agentboard brief --json                 Grouped summary: underway, ready,
                                          blocked, waiting, paused.
  agentboard brief --spoken               The same board as speakable prose —
                                          labels only, never ids or paths.
  agentboard state                        The bearings dump: counts plus what
                                          fits a token budget; silent when clear.
  agentboard list --state open --json     Filter by state; --tag filters by tag.
  agentboard get "the auth cleanup" --json  One item with relations, refs, and
                                          the blockers keeping it out of ready.
  agentboard search "auth" --json         Match label, title, summary, and tags.
  agentboard resolve "auth" --json        Ranked candidates when a phrase is
                                          ambiguous; use before guessing.
  agentboard events <ref> --json          The item's append-only history.
  agentboard tree --json                  Containment forest. graph --json is the
                                          full node/edge export.

Taking work
  agentboard claim <ref> --agent codex --json     Atomic; a second claim is
                                          refused with already_claimed rather
                                          than queued. Re-claiming as the same
                                          agent is idempotent.
  agentboard release <ref>                Give it back; the item returns to open.
  agentboard done <ref> --note "..."      Terminal states are frozen: nothing
  agentboard cancel <ref> --reason "..."  transitions out of done, cancelled, or
  agentboard supersede <ref> --by <ref>   superseded. Capture follow-ups instead.

Capturing and shaping
  agentboard add the auth cleanup --summary "..." --tag auth,security --json
    Refused with existing_topic when an open item already covers that topic —
    that is the point. Pass --new only when a second item is genuinely wanted.
  agentboard edit <ref> --label "..."     Reword one item. A rename recomputes
                                          the topic key and is refused if it
                                          collides with another open item.
  agentboard relate <a> depends-on <b>    Acyclic kinds are validated on write.
  agentboard link <ref> --wiki some-slug --rel spec
  agentboard order --id "a,b,c" --to next  Dictated sequence is preserved exactly;
                                          "next" queues behind every claimed
                                          item, so it never displaces an agent's
                                          work in progress.
  agentboard wait <ref> --reason "..."    "Blocked" is never a stored state — it
                                          is computed from depends-on edges.
  agentboard rm <ref> --reason "..."      A tombstone, not a delete; restore
                                          returns the item to the rank it held.

Bulk reshaping — grooming drafts are the only path
  agentboard groom export --json          Gives you baseRevision, items, relations.
  agentboard groom apply draft.json       Atomic: it lands completely or writes
                                          nothing, and is idempotent by draftId.

Handing it to a human
  agentboard render --out board.html [--publish]   Static self-contained snapshot;
    --publish hands it to agentwiki. agentboard never runs a server.
  agentboard export --jsonl > board.jsonl ; agentboard import board.jsonl
    Full-fidelity eject and reload. Import only ever writes into an empty board.

Deep runbooks: the \`board\` and \`groom\` agent skills, installed globally; this
text is the in-binary fallback.`;

interface ErrorCode {
  code: string;
  meaning: string;
  recovery?: string;
}

/**
 * Every code this CLI can put in an ok:false envelope. The refusal sites in
 * code are the only other place these strings may appear.
 */
const ERROR_CODES: ErrorCode[] = [
  {
    code: "existing_topic",
    meaning: "An item already open holds that topic key.",
    recovery: "Supersede or relate the two, or pass --new to capture a second one anyway.",
  },
  {
    code: "ambiguous_ref",
    meaning: "More than one item matched the phrase in the strongest matching tier.",
    recovery: "Run resolve on the phrase and pass an id, or say something more specific.",
  },
  { code: "unknown_ref", meaning: "No item matched the reference." },
  { code: "empty_ref", meaning: "The reference was blank." },
  {
    code: "already_claimed",
    meaning: "Another agent holds the claim.",
    recovery: "Pick another item from ready, or ask that agent to release it.",
  },
  {
    code: "not_claimable",
    meaning: "Only open work can be claimed.",
    recovery: "Resume a waiting or paused item first.",
  },
  { code: "not_claimed", meaning: "The item is not claimed, so there is nothing to release." },
  { code: "not_resumable", meaning: "Only waiting or paused work resumes." },
  { code: "agent_required", meaning: "A claim names the agent taking the work." },
  {
    code: "terminal_item",
    meaning: "Terminal states are frozen; the transition would rewrite history.",
    recovery: "Capture the follow-up as a new item, or supersede this one from it.",
  },
  {
    code: "removed_item",
    meaning: "The item is tombstoned, so it is invisible to every mutation.",
    recovery: "Restore it first.",
  },
  { code: "already_removed", meaning: "The item is already tombstoned." },
  { code: "not_removed", meaning: "The item is not tombstoned, so there is nothing to restore." },
  {
    code: "reason_required",
    meaning: "The target state's whole content is its reason, and none was given.",
    recovery: 'Pass --reason "...".',
  },
  { code: "blank_label", meaning: "An item needs a speakable label." },
  { code: "blank_title", meaning: "A title cannot be blank." },
  { code: "nothing_to_update", meaning: "No field to change was given." },
  { code: "self_relation", meaning: "An item cannot be related to itself." },
  { code: "self_supersede", meaning: "An item cannot supersede itself." },
  {
    code: "relation_cycle",
    meaning: "The edge closes a loop in an acyclic kind.",
    recovery:
      "Relate the items the other way round, or use related-to, which carries no direction.",
  },
  { code: "duplicate_relation", meaning: "That edge already exists between those two items." },
  { code: "unknown_relation", meaning: "Those two items carry no edge of that kind." },
  { code: "duplicate_ref", meaning: "The item already references that target." },
  { code: "unknown_ref_target", meaning: "The item does not reference that target." },
  { code: "empty_move", meaning: "A move needs at least one item to move." },
  { code: "duplicate_move_id", meaning: "A move cannot name the same item twice." },
  {
    code: "self_placement",
    meaning: "An item cannot be placed relative to itself.",
    recovery: "Name an anchor that is not part of the move.",
  },
  {
    code: "stale_draft",
    meaning: "The board moved since the draft's baseRevision.",
    recovery: "Re-export and rebuild the draft.",
  },
  {
    code: "draft_conflict",
    meaning: "That draftId was already applied with different bytes.",
    recovery: "Mint a new draftId for a genuinely new draft.",
  },
  {
    code: "groom_refused",
    meaning: "The draft is malformed or out of its declared scope; nothing was written.",
    recovery: "Fix the draft and apply it again.",
  },
  { code: "unreadable_draft", meaning: "The draft file could not be read as JSON." },
  { code: "unreadable_file", meaning: "A named file could not be read." },
  { code: "unreadable_export", meaning: "An ejected line could not be read." },
  {
    code: "invalid_export_value",
    meaning: "An ejected line carries a value outside the enum its column allows.",
    recovery: "Edit that line to a legal value and import again.",
  },
  {
    code: "board_not_empty",
    meaning: "Import only ever writes into an empty board.",
    recovery: "Point --db at a fresh path, or move the existing board aside first.",
  },
  {
    code: "unsupported_schema_version",
    meaning: "The board is at a schema version this build does not understand.",
    recovery: "Upgrade agentboard; an older build must not migrate a newer board backwards.",
  },
  { code: "bad_schema_version", meaning: "The board's schema_version is not an integer." },
  {
    code: "agentwiki_missing",
    meaning: "render --publish needs agentwiki on PATH.",
    recovery: "The snapshot is written; publish it later with agentwiki publish.",
  },
  { code: "publish_failed", meaning: "agentwiki refused the publish or returned no envelope." },
  { code: "write_failed", meaning: "A row did not survive its own write." },
  { code: "id_exhausted", meaning: "No unused item id could be minted." },
  { code: "no_home", meaning: "HOME is unset, so the default board path cannot be resolved." },
  { code: "internal_error", meaning: "An unexpected failure, reported rather than swallowed." },
];

/** Full paths of every leaf declaring mutates:false; the validator pins this. */
function readOnlyCommands(): string[] {
  const paths: string[] = [];
  const walk = (commands: ContractCommand[], prefix: string[]): void => {
    for (const command of commands) {
      const path = [...prefix, command.name];
      if (command.subcommands !== undefined) walk(command.subcommands, path);
      else if (command.mutates === false) paths.push(path.join(" "));
    }
  };
  walk(COMMANDS, []);
  return paths;
}

export function buildContract(dbPath: string): Record<string, unknown> {
  return {
    contract_version: CONTRACT_VERSION,
    meta: {
      name: "agentboard",
      version: VERSION,
      purpose:
        "Agent-first planning board: capture, order, claim, and finish work at any granularity — one item type, typed relations, computed ready-work over a dependency graph, atomic claims, spoken briefs, and atomic grooming drafts.",
      audience: "agent",
    },
    guidance: GUIDANCE,
    concepts: {
      model: {
        item: "The single unit of work at any granularity. Granularity is expressed by relations, never by a second type.",
        id: "Opaque: `it-` plus 8 hex. Never spoken; every <ref> argument accepts a label or phrase instead.",
        label: "The short speakable name — the voice surface.",
        title: "The readable display variant; defaults from the label.",
        topic_key:
          "Normalized label (lowercase, alphanumeric-joined, leading article stripped). `add` refuses a label whose topic key matches an item already open, with code existing_topic; --new overrides.",
        order:
          "One dense, unique, zero-based rank over every row. Priority and nothing else: it survives state changes, tombstoning, and restore. Every listing is this one sequence, filtered.",
        claim: "Atomic take by one agent. A second claim is refused, never queued.",
        ready:
          "Computed on every call: open items whose depends-on targets have all finished, in order. Never stored, so it cannot go stale. 'Blocked' is never a stored state.",
        tombstone:
          "`rm` marks, never erases. State, rank, and history are kept; `restore` returns the item to the rank it held.",
      },
      states: {
        all: ITEM_STATES,
        terminal: TERMINAL_STATES,
        frozen: "Nothing transitions out of a terminal state; capture a follow-up item instead.",
        reason_required: REASON_REQUIRED_STATES,
        claim_semantics:
          "`claim` moves open → active and records the agent. `release` clears the claim and returns the item to open. `wait` and `pause` keep the claim; `resume` returns to active when still claimed, else to open.",
      },
      relations: {
        kinds: RELATION_KINDS,
        symmetric: ["conflicts-with", "related-to"],
        symmetric_note: "Stored with endpoints sorted, so a reversed restatement is a duplicate.",
        acyclic: ["contains", "depends-on", "supersedes"],
        acyclic_note:
          "Validated per kind on write; a mixed-kind loop is a modeling choice, not a refusal.",
        refs: {
          forms: ["wiki:<slug>", "artifact:<name>", "<url>"],
          rels: REF_RELS,
          note: "Refs point outward at other systems; relations point at other items.",
        },
      },
      order: {
        placements: PLACEMENTS,
        note: "`order --id a,b,c` keeps the dictated sequence exactly, so one spoken run of work is one call. `next` lands behind every item already underway (state active) — all of them, not just the first — so reprioritizing what comes next never displaces work an agent is holding. With nothing underway it is the same as first.",
      },
      ref_resolution: {
        tiers: MATCH_TIERS,
        accepts:
          "Every <ref> may be an id, a label, a rough restatement of one, or any unambiguous phrase from a label — ids are opaque and never need to be spoken.",
        note: "Strongest tier first, stopping at the first that matches. Live items outrank tombstoned ones within a tier. More than one match in the chosen tier is refused with ambiguous_ref naming the candidates.",
        helper: "agentboard resolve <phrase> --json returns the ranked candidates as data.",
      },
      grooming: {
        why: "The sole bulk-mutation path: atomic, idempotent by draftId, refused when stale or out of declared scope.",
        export:
          "agentboard groom export --json → {version, baseRevision, generatedAt, items, relations}",
        apply: "agentboard groom apply <file>",
        operations: ["create-item", "update-item", "close-item", "add-relation", "remove-relation"],
        close_states: GROOM_CLOSE_STATES,
        operation_limit: GROOM_OPERATION_LIMIT,
        temp_ids:
          "create-item carries a draft-local tempId that later operations may name; the applied bindings are returned and stored.",
        scope:
          "A scoped draft must resolve its scope into scopeItemIds. Touching anything else needs an entry in expansions with a reason. depends-on, conflicts-with, and related-to may cross the boundary with one declared endpoint; contains and supersedes need both, as does every removal.",
        idempotency:
          "Replaying the same draftId with identical bytes reports already_applied and changes nothing; different bytes are refused as draft_conflict.",
        staleness:
          "baseRevision must equal the current board revision; otherwise stale_draft — re-export.",
      },
      voice: {
        spoken_brief: "agentboard brief --spoken",
        guarantee:
          "Labels only — never an id, hash, or path. Every live unfinished item produces at least one line, so silence can only mean the board is empty.",
      },
      bearings: {
        state_dump: "agentboard state [--budget <tokens>]",
        guarantee:
          "The counts header accounts for everything open even when the budget names only some of it; no output at all means the board is clear.",
      },
      integration: {
        publish:
          "render --publish shells out to `agentwiki publish <file> --name agentboard --kind render --json` when agentwiki is on PATH, and returns that envelope's data unchanged as `published`.",
        server: "agentboard never runs an HTTP server.",
        eject:
          "agentboard export --jsonl and agentboard import <file> (into an empty database only).",
      },
      storage: {
        default_db: "~/.local/share/agentboard/board.sqlite3",
        db_path: dbPath,
        board_schema_version: BOARD_SCHEMA_VERSION,
        note: "--db outranks AGENTBOARD_DB, which outranks the default path.",
      },
      output_contract: {
        envelope: {
          schema_version: "number",
          ok: "boolean",
          error: "{code,message,recovery?} | null",
          data: "command payload | null",
        },
        exit_codes: {
          "0": "success",
          "1": "domain failure (ok:false envelope on stdout)",
          "2": "usage fault (help on stderr, never an envelope)",
        },
        stdin: "No command reads standard input; every input is an argument or a named file.",
      },
      error_codes: ERROR_CODES,
      read_only_commands: readOnlyCommands(),
      agent_defaults: [
        "Start with: agentboard guide --json",
        "Pick work with: agentboard ready --json, then agentboard claim <ref> --agent <you> --json",
        "Report with: agentboard done <ref> --note '...' --json",
        "Never guess between two items: agentboard resolve <phrase> --json first.",
        "Reshape in bulk only through groom export → groom apply.",
      ],
    },
    global_arguments: GLOBAL_ARGUMENTS,
    commands: COMMANDS,
  };
}

// --- Derivations ---

export function findCommand(name: string): ContractCommand | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Every argument a command accepts, its subcommands' included: a group is
 * dispatched by positional, so its flags are the union of its leaves'. */
function allArguments(command: ContractCommand): ContractArgument[] {
  if (command.subcommands === undefined) return command.arguments ?? [];
  return command.subcommands.flatMap(allArguments);
}

/** The flag grammar cli.ts parses with — derived, never authored twice. */
export function commandFlags(name: string): { value: string[]; bool: string[] } {
  const command = findCommand(name);
  if (command === undefined) return { value: [], bool: [] };
  const value: string[] = [];
  const bool: string[] = [];
  for (const argument of allArguments(command)) {
    if (argument.positional === true) continue;
    (argument.type === "boolean" ? bool : value).push(argument.name);
  }
  return { value: [...new Set(value)], bool: [...new Set(bool)] };
}

export function globalFlags(): { value: string[]; bool: string[] } {
  const value = GLOBAL_ARGUMENTS.filter((a) => a.type !== "boolean").map((a) => a.name);
  const bool = GLOBAL_ARGUMENTS.filter((a) => a.type === "boolean").map((a) => a.name);
  return { value, bool };
}
