/**
 * The machine card: the contract an agent can read once and then drive the
 * board without reading source or guessing at semantics.
 */

import { GROOM_CLOSE_STATES, GROOM_OPERATION_LIMIT } from "./groom.ts";
import { COMMANDS, VERSION } from "./help.ts";
import { PLACEMENTS } from "./order.ts";
import { MATCH_TIERS } from "./resolve.ts";
import { BOARD_SCHEMA_VERSION } from "./schema.ts";
import {
  ITEM_STATES,
  REASON_REQUIRED_STATES,
  REF_RELS,
  RELATION_KINDS,
  TERMINAL_STATES,
} from "./types.ts";

export function buildGuide(dbPath: string): unknown {
  return {
    name: "agentboard",
    version: VERSION,
    purpose:
      "Agent-first planning board: one item type at every granularity, typed relations, computed ready-work, atomic claims, and voice-first mechanics over an embedded SQLite database.",
    default_db: "~/.local/share/agentboard/board.sqlite3",
    db_path: dbPath,
    board_schema_version: BOARD_SCHEMA_VERSION,
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
    order_placements: PLACEMENTS,
    order_note:
      "`order --id a,b,c` keeps the dictated sequence exactly, so one spoken run of work is one call. `next` lands behind every item already underway (state active) — all of them, not just the first — so reprioritizing what comes next never displaces work an agent is holding. With nothing underway it is the same as first.",
    ref_resolution: {
      tiers: MATCH_TIERS,
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
    integration: {
      render: "agentboard render --out <path> [--publish] writes one self-contained HTML file.",
      publish:
        "--publish shells out to `agentwiki publish <file> --name agentboard --kind render` when agentwiki is on PATH.",
      server: "agentboard never runs an HTTP server.",
      eject:
        "agentboard export --jsonl and agentboard import <file> (into an empty database only).",
    },
    global_flags: [
      {
        flag: "--db <path>",
        meaning: "Board database; outranks AGENTBOARD_DB and the default path.",
      },
      { flag: "--json", meaning: "Stable envelope; preferred for agents." },
      {
        flag: "--jsonl",
        meaning: "One record per line for list, search, ready, graph, and export.",
      },
      { flag: "--agent-help", meaning: "Text runbook for agents; this card is the machine form." },
      { flag: "--agent-teaser", meaning: "One-line capability summary." },
    ],
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
      error_codes: [
        "existing_topic",
        "ambiguous_ref",
        "unknown_ref",
        "already_claimed",
        "not_claimable",
        "not_claimed",
        "terminal_item",
        "removed_item",
        "reason_required",
        "relation_cycle",
        "duplicate_relation",
        "unknown_relation",
        "stale_draft",
        "draft_conflict",
        "groom_refused",
        "board_not_empty",
        "unsupported_schema_version",
      ],
    },
    commands: COMMANDS.map((command) => ({ name: command.name, summary: command.summary })),
    read_only_commands: [
      "get",
      "list",
      "search",
      "events",
      "resolve",
      "ready",
      "tree",
      "graph",
      "brief",
      "groom export",
      "export",
      "render",
      "guide",
    ],
    agent_defaults: [
      "Start with: agentboard guide --json",
      "Pick work with: agentboard ready --json, then agentboard claim <ref> --agent <you> --json",
      "Report with: agentboard done <ref> --note '...' --json",
      "Never guess between two items: agentboard resolve <phrase> --json first.",
      "Reshape in bulk only through groom export → groom apply.",
    ],
  };
}
