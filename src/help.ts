/**
 * Help text. Three audiences, three shapes: `--help` orients a person,
 * `--agent-help` is a runbook an agent can follow without reading source, and
 * `guide --json` is the machine card. They must agree; when a command's
 * semantics change, all three change.
 */

export const VERSION = "0.1.0";

export const COMMANDS = [
  { name: "add", summary: "Capture an item from spoken words" },
  { name: "get", summary: "Show one item with its relations, refs, and blockers" },
  { name: "list", summary: "List the board in order, filtered by state or tag" },
  { name: "search", summary: "Find items whose label, title, summary, or tags match" },
  { name: "events", summary: "Show one item's append-only event log" },
  { name: "resolve", summary: "Rank the items a spoken phrase could name" },
  { name: "ready", summary: "List open items with no unfinished blockers, in order" },
  { name: "claim", summary: "Take an item atomically for one agent" },
  { name: "release", summary: "Give a claimed item back to the board" },
  { name: "done", summary: "Close an item as finished" },
  { name: "cancel", summary: "Close an item as cancelled, with a reason" },
  { name: "supersede", summary: "Close an item as superseded by another" },
  { name: "wait", summary: "Park an item on something outside the board" },
  { name: "pause", summary: "Set an item aside deliberately" },
  { name: "resume", summary: "Bring a waiting or paused item back" },
  { name: "order", summary: "Move items to one place in the board's order" },
  { name: "relate", summary: "Add a typed edge between two items" },
  { name: "unrelate", summary: "Remove a typed edge between two items" },
  { name: "link", summary: "Reference a wiki page, artifact, or URL from an item" },
  { name: "unlink", summary: "Drop one of an item's outward references" },
  { name: "tree", summary: "Show the containment forest" },
  { name: "graph", summary: "Export every node and edge as JSON" },
  { name: "brief", summary: "Summarize the board, read or spoken" },
  { name: "groom", summary: "Export a grooming draft, or apply one atomically" },
  { name: "rm", summary: "Tombstone an item, keeping its rank and history" },
  { name: "restore", summary: "Bring a removed item back to the rank it held" },
  { name: "export", summary: "Eject the whole board as JSONL" },
  { name: "import", summary: "Load an ejected board into an empty database" },
  { name: "render", summary: "Write a self-contained HTML snapshot of the board" },
  { name: "guide", summary: "Print the stable machine-readable agent contract" },
] as const;

const COMMAND_LINES = COMMANDS.map(
  (command) => `  ${command.name.padEnd(10)} ${command.summary}`,
).join("\n");

export const TOP_HELP = `agentboard — agent-first planning board

Usage:
  agentboard [command] [options]

Global options:
  --db <path>      Board database (default: ~/.local/share/agentboard/board.sqlite3;
                   env: AGENTBOARD_DB)
  --json           Emit the stable {schema_version, ok, error, data} envelope
  --jsonl          Emit one record per line where a command streams (list, search,
                   ready, export, graph)
  --help, -h       Show this help, or a command's help after the command name
  --version, -V    Show the version
  --agent-help     Show the agent runbook
  --agent-teaser   Show a one-line capability summary

Commands:
${COMMAND_LINES}

Every <ref> may be an id, a label, a rough restatement of one, or any unambiguous
phrase from a label — ids are opaque and never need to be spoken.

Run agentboard --agent-help for the agent runbook.
`;

export const AGENT_TEASER =
  "Capture, order, claim, and complete work at any granularity: computed ready-work over a dependency graph, atomic claims, spoken briefs, and atomic grooming drafts.";

export const AGENT_HELP = `agentboard — agent-first planning board (agent runbook)

One item type at every granularity. Relations, not a second type, are what make
one item a program and another a one-liner. Ids are opaque: pass a label or any
unambiguous phrase wherever a command takes <ref>.

Reading (safe anytime)
  agentboard ready --json                 Open items with no unfinished blockers,
                                          in board order. Start here.
  agentboard brief --json                 Grouped summary: underway, ready,
                                          blocked, waiting, paused.
  agentboard brief --spoken               The same board as speakable prose —
                                          labels only, never ids or paths.
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
  agentboard relate <a> depends-on <b>    contains | depends-on | conflicts-with |
                                          supersedes | related-to. Acyclic kinds
                                          are validated on write.
  agentboard link <ref> --wiki some-slug --rel spec
  agentboard order --id "a,b,c" --to next  Dictated sequence is preserved exactly;
                                          one "then this, then this" is one call.
  agentboard wait <ref> --reason "..."    "Blocked" is never a stored state — it
                                          is computed from depends-on edges.
  agentboard rm <ref> --reason "..."      A tombstone, not a delete; restore
                                          returns the item to the rank it held.

Bulk reshaping — grooming drafts are the only path
  agentboard groom export --json          Gives you baseRevision, items, relations.
  agentboard groom apply draft.json       Five operations: create-item,
    update-item, close-item, add-relation, remove-relation. tempIds let one draft
    reference items it creates. Atomic: it lands completely or writes nothing.
    Replaying the same draftId with identical bytes reports already_applied and
    changes nothing; different bytes are refused as draft_conflict; a moved board
    is refused as stale_draft (re-export). Declare scopeItemIds when the draft is
    scoped, and expansions for anything you touch beyond it.

Handing it to a human
  agentboard render --out board.html [--publish]   Static self-contained snapshot;
    --publish hands it to agentwiki. agentboard never runs a server.
  agentboard export --jsonl > board.jsonl ; agentboard import board.jsonl
    Full-fidelity eject and reload. Import only ever writes into an empty board.

Output contract: with --json every outcome is one {schema_version, ok, error, data}
envelope on stdout — exit 0 on success, exit 1 with ok:false and a snake_case
error.code on a domain failure; a usage fault prints help on stderr and exits 2
without an envelope.

Full machine card: agentboard guide --json
`;

export const HELP: Record<string, string> = {
  add: `agentboard add — capture an item

Usage:
  agentboard add <label words...> [--title T] [--summary S] [--tag a,b] [--new]
                                  [--origin human|agent]

The label is the speakable name and the voice surface; the title defaults to it.
A label whose topic key matches an item already open on the board is refused with
existing_topic, naming the match — pass --new to capture a second one anyway.

Examples:
  agentboard add the auth cleanup --tag auth,security
  agentboard add fix the flaky login test --summary "fails ~1 in 20 on CI" --json
`,
  get: `agentboard get — one item in full

Usage:
  agentboard get <ref> [--json]

Shows state, order, claim, tags, summary, every relation, every outward ref, and
the unfinished blockers keeping the item out of ready.
`,
  list: `agentboard list — the board in order

Usage:
  agentboard list [--state open|active|waiting|paused|done|superseded|cancelled]
                  [--tag <tag>] [--all] [--json|--jsonl]

Default: live and unfinished, in board order. --state selects one state (including
terminal ones), --all includes finished items, and --tag filters by tag.
`,
  search: `agentboard search — find items

Usage:
  agentboard search <query> [--json|--jsonl]

Matches label, title, summary, and tags, case-insensitively, over live items.
`,
  events: `agentboard events — one item's history

Usage:
  agentboard events <ref> [--json]

Every mutation appends here and bumps the item's revision; nothing is rewritten.
`,
  resolve: `agentboard resolve — what a phrase could name

Usage:
  agentboard resolve <phrase> [--json]

Ranked candidates with the tier that matched: id, label, topic, or contains.
`,
  ready: `agentboard ready — what can be picked up now

Usage:
  agentboard ready [--json|--jsonl]

Open items whose depends-on targets have all finished, in board order. Ready is
computed on every call, never stored, so it cannot go stale.
`,
  claim: `agentboard claim — take an item

Usage:
  agentboard claim <ref> --agent <name> [--json]

Atomic: the write transaction takes the lock before reading, so two agents racing
for the same item cannot both win. A second agent is refused with already_claimed.
Only open items are claimable; resume a waiting or paused item first.
`,
  release: `agentboard release — give an item back

Usage:
  agentboard release <ref> [--json]

Clears the claim and returns the item to open, wherever it sat.
`,
  done: `agentboard done — close an item as finished

Usage:
  agentboard done <ref> [--note "..."] [--json]
`,
  cancel: `agentboard cancel — close an item as cancelled

Usage:
  agentboard cancel <ref> --reason "..." [--json]
`,
  supersede: `agentboard supersede — one item takes over from another

Usage:
  agentboard supersede <ref> --by <ref> [--note "..."] [--json]

Closes the first item as superseded and records a supersedes edge from the
successor to it.
`,
  wait: `agentboard wait — park an item on something outside the board

Usage:
  agentboard wait <ref> --reason "..." [--json]

The reason is the whole content of the state, so it is required. A dependency on
another item is a depends-on relation instead — that is what ready computes from.
`,
  pause: `agentboard pause — set an item aside deliberately

Usage:
  agentboard pause <ref> --reason "..." [--json]

Pausing is about attention, not priority: the item keeps its rank.
`,
  resume: `agentboard resume — bring an item back

Usage:
  agentboard resume <ref> [--json]

Returns a waiting or paused item to active if it is still claimed, else to open.
`,
  order: `agentboard order — set priority

Usage:
  agentboard order --id "<ref>,<ref>,..." --to first|next|last|after <ref> [--json]

The listed items keep the sequence they were named in, so one dictated run of
work is one call. "next" lands behind the item currently leading the board;
"after" names an anchor. Order is priority and nothing else: it never claims
work, changes a state, or overrides a depends-on edge.

Examples:
  agentboard order --id "the auth cleanup,the log panel" --to next
  agentboard order --id it-9f2a41bc --to after "the auth cleanup"
`,
  relate: `agentboard relate — add a typed edge

Usage:
  agentboard relate <ref> <kind> <ref> [--note "..."] [--json]

Kinds: contains, depends-on, conflicts-with, supersedes, related-to.
conflicts-with and related-to read the same either way and dedupe regardless of
direction. contains, depends-on, and supersedes are validated acyclic on write.
`,
  unrelate: `agentboard unrelate — remove a typed edge

Usage:
  agentboard unrelate <ref> <kind> <ref> [--json]
`,
  link: `agentboard link — reference something outside the board

Usage:
  agentboard link <ref> (--wiki <slug> | --url <url> | --artifact <name>)
                        [--rel spec|notes|evidence] [--json]

Refs point outward; relations point at other items. Default rel is notes.
`,
  unlink: `agentboard unlink — drop an outward reference

Usage:
  agentboard unlink <ref> (--wiki <slug> | --url <url> | --artifact <name>) [--json]
`,
  tree: `agentboard tree — the containment forest

Usage:
  agentboard tree [--root <ref>] [--json]
`,
  graph: `agentboard graph — every node and edge

Usage:
  agentboard graph [--json|--jsonl]
`,
  brief: `agentboard brief — summarize the board

Usage:
  agentboard brief [--spoken] [--json]

--spoken renders speakable prose: labels only, never ids, hashes, or paths. Every
live unfinished item produces a line, so silence means the board is truly empty.
`,
  groom: `agentboard groom — the only bulk-mutation path

Usage:
  agentboard groom export [--json] [--out <path>]
  agentboard groom apply <file> [--json]

export gives the baseRevision the draft must be built on, plus every live item
and relation. apply is atomic and idempotent by draftId. See --agent-help for the
operation set and the refusal codes.
`,
  rm: `agentboard rm — tombstone an item

Usage:
  agentboard rm <ref> --reason "..." [--json]

Nothing is erased: the state, the rank, and the event log are all kept, and the
item simply stops being visible to every operational reader.
`,
  restore: `agentboard restore — bring a removed item back

Usage:
  agentboard restore <ref> [--reason "..."] [--json]

The item returns with the state and the rank it held.
`,
  export: `agentboard export — eject the board

Usage:
  agentboard export [--jsonl] [--out <path>]

Full fidelity: items including tombstones, events, relations, refs, and the
grooming audit. The hedge against this schema: everything can leave.
`,
  import: `agentboard import — load an ejected board

Usage:
  agentboard import <file> [--json]

Only ever writes into an empty board, so it can never merge two histories.
`,
  render: `agentboard render — a static snapshot for a human

Usage:
  agentboard render [--out <path>] [--publish] [--json]

Writes one self-contained HTML file: kanban columns by state, plus the
containment tree. --publish hands it to \`agentwiki publish\` when agentwiki is on
PATH. agentboard never runs an HTTP server.
`,
  guide: `agentboard guide — the machine card

Usage:
  agentboard guide --json
`,
};
