---
name: board
description: Drive the agentboard planning board with the agentboard CLI — capture, order, claim, and finish work at any granularity. Use whenever something needs to go on the board or the plan ("add this", "track that", "put it on the backlog"); when asked what to work on ("what's next", "what's ready"); before starting a piece of work and when it is finished; when items need relating, sequencing, or parking; and when someone asks what is going on. One item type at every granularity, and ids are opaque — speak labels. Reshaping several items at once is the groom skill.
---

# Board — the agentboard planning board

agentboard is an agent-first planning board over an embedded SQLite database:
one item type at every granularity, typed relations, ready-work computed from
the dependency graph on every call, atomic claims, and a spoken brief. This
skill is the runbook for driving it — capturing work, deciding what to pick up,
taking it, and closing it.

The board is shared state. Other agents and the human read it, claim from it,
and are told what you are doing by what you write to it, so a claim you never
took and a `done` you never recorded are both lies the next reader believes.

Verified against agentboard 0.1.0. The CLI is self-describing — when this
document and the installed binary disagree, the binary wins; see
[Discovery and drift](#discovery-and-drift).

## Non-negotiables

- **Speak labels, never ids.** Every `<ref>` argument takes a label, a rough
  restatement of one, or any unambiguous phrase from a label. Ids (`it-` plus
  8 hex) are opaque plumbing: pass one back when a command just printed it,
  but never read one aloud, write one into prose, or ask a human for one.
- **Parse the envelope, not the prose.** Add `--json` to every call whose
  result you branch on. Human output is for humans and is not a contract.
- **`ready` is where work comes from.** It is the computed set of open items
  whose blockers have finished, in board order. Picking off `list` hands you
  work that something else has to land first.
- **Claim before you start; close when you finish.** A claim is atomic and is
  how a second agent learns the work is taken. Between the two, the board says
  you are on it.
- **Several items at once is a grooming draft, never a loop.** One `edit`, one
  `relate`, one `order` call is fine. Three items rewritten one command at a
  time loses atomicity and races whoever else is writing — that is the
  [`groom` skill](#sibling-skills).
- **Terminal states are frozen.** Nothing transitions out of `done`,
  `cancelled`, or `superseded`. A follow-up is a new item, not a reopening.

## First contact

```bash
agentboard guide --json     # the machine card: model, states, codes, commands
agentboard ready --json     # what can be picked up right now
agentboard brief            # the grouped summary of everything live
```

`guide` needs no database and will not conjure one, so it is always safe. The
board itself lives at `~/.local/share/agentboard/board.sqlite3`, overridable
with `--db <path>` or `AGENTBOARD_DB`. Global flags may go before or after the
command name: `agentboard --json ready` and `agentboard ready --json` are the
same call.

## The item model

One item type at every granularity. A one-line snippet, a bug, and a multi-part
program are the same record — what makes one of them large is a `contains`
edge, not a second type. There is deliberately no "epic" and no "task", so a
one-liner that turns out to be a program grows edges instead of being migrated.

| Field | What it is |
|---|---|
| `label` | The short speakable name — the voice surface |
| `title` | The readable display variant; defaults from the label |
| `topic_key` | Normalized label; how a recapture finds the item already open |
| `state` | `open`, `active`, `waiting`, `paused`, and the frozen `done`, `superseded`, `cancelled` |
| `rank` | One dense order over every row. Priority and nothing else |
| `claim` | `{agent, at}` — who holds it |
| `tags` | Set at capture with `--tag a,b`; afterwards only a draft can change them |

Resolution runs strongest tier first — exact id, then exact label or title,
then same topic said differently, then a phrase occurring in a label — and
stops at the first tier that matches anything. More than one match inside that
tier is refused with `ambiguous_ref` naming the candidates rather than guessed:

```bash
agentboard resolve "auth" --json    # ranked candidates with the tier that matched
```

## Reading the board

```bash
agentboard ready --json                 # start here: open, unblocked, in order
agentboard brief --json                 # underway / ready / blocked / waiting / paused
agentboard brief --spoken               # the same board as speakable prose
agentboard get "the auth cleanup" --json  # one item in full
agentboard list --state waiting --json  # one state; --tag filters; --all includes finished
agentboard search checkout --json       # label, title, summary, tags — live items, closed included
agentboard events "the auth cleanup" --json   # the append-only history
agentboard tree --json                  # the containment forest
agentboard graph --json                 # every node, edge, and outward ref
```

`get` is the one that answers "why can't I start this": alongside state, order,
claim, tags, relations, and refs it returns `ready` and the `blockers` keeping
the item out of it.

`brief --spoken` is the voice surface, and its guarantee is structural: labels
only — never an id, a hash, or a path — and every live unfinished item produces
at least one line, so silence can only mean the board is empty. Use it whenever
the answer is going to be heard rather than read.

`list` defaults to live and unfinished. `search` spans every live item
including closed ones, which is how you find what a topic was called before it
was finished. Neither shows tombstones.

## The work loop

```bash
agentboard ready --json                                  # 1. what is available
agentboard claim "the auth cleanup" --agent codex --json # 2. take it
# ... do the work ...
agentboard done "the auth cleanup" --note "rotated the tokens" --json   # 3. close it
```

A claim is atomic: the write transaction takes the lock before it reads, so two
agents racing for one item cannot both win. Four concurrent claims produce one
success and three `already_claimed` refusals — never a queue. Re-claiming as
the same agent is idempotent: it writes nothing, appends no event, and does not
advance the revision, so a retry after a crash is safe.

Only `open` work is claimable. `release` clears the claim and returns the item
to `open` wherever it sat. `wait` and `pause` keep the claim, because an agent
that hit a blocker still owns the work it stopped on; `resume` returns such an
item to `active` when it is still claimed, else to `open`.

Closing has three doors, and picking the honest one matters more than closing
quickly: `done` for finished, `cancel --reason` for work that will not happen,
and `supersede --by <ref>` when another item took over — which closes the first
and records a `supersedes` edge from the successor in one step.

## Capturing work

```bash
agentboard add the auth cleanup --tag auth,security --json
agentboard add fix the flaky login test --summary "fails 1 in 20 on CI" --json
```

The positional words are the label; whitespace is collapsed, so dictated
capture arrives intact. New items land at the end of the order — sequence them
afterwards if the order matters.

Capture refuses a label whose topic already has an item open:

```json
{"code":"existing_topic",
 "message":"\"the auth cleanup\" (it-86195f25) is already on the board for that topic",
 "recovery":"add to it instead, or pass --new to capture a second item on the same topic"}
```

**That refusal is the feature.** The right move is almost always to `get` the
named item and extend it — a sharper summary, a `contains` child, a
`depends-on` edge — not to force a second copy. Reach for `--new` only when a
second item is genuinely wanted, and know the cost: two open items share a
topic key, so the phrase that used to name one now resolves ambiguously and
every later reference has to be more specific.

`edit` reworks exactly one item:

```bash
agentboard edit "the auth cleanup" --label "the token rotation" --json
agentboard edit "the auth cleanup" --summary "..." --json
```

At least one of `--label`, `--title`, `--summary` is required; there is no
`--tag` on `edit`. Renaming recomputes the topic key and is refused with
`existing_topic` if it would collide with another open item. Rewriting several
items is a grooming draft.

## Shaping the board

**Relations** are typed edges between items: `contains`, `depends-on`,
`conflicts-with`, `supersedes`, `related-to`.

```bash
agentboard relate "reindex the cluster" depends-on "rebuild the index" --json
agentboard unrelate "reindex the cluster" depends-on "rebuild the index" --json
```

`conflicts-with` and `related-to` read the same either way and are stored with
their endpoints sorted, so a reversed restatement is a duplicate, not a second
edge. `contains`, `depends-on`, and `supersedes` are validated acyclic on
write, per kind — a loop that only exists by mixing kinds is a modeling choice
the board does not refuse.

**"Blocked" is never stored.** It is computed from `depends-on` on every call,
which is why it cannot go stale. `waiting` is the different fact that an item
is parked on something *outside* the board, and it carries the reason because
the reason is the whole content of that state. `pause` is a deliberate
set-aside about attention, not priority — a paused item keeps its rank.

```bash
agentboard wait "the migration" --reason "waiting on the DBA window" --json
agentboard pause "the redesign" --reason "until the brand work lands" --json
agentboard resume "the migration" --json
```

**Order** is one dense rank over every row — priority and nothing else. It
survives state changes, removal, and restore, and it never claims work,
changes a state, or overrides a dependency.

```bash
agentboard order --id "the auth cleanup,the log panel,the CSV export" --to next --json
agentboard order --id "the log panel" --to after "the auth cleanup" --json
```

The named items keep the sequence they were given, so one dictated "then this,
then this, then this" is **one call**, not three. Placements are `first`,
`next`, `last`, and `after <ref>`. `next` lands behind *every* item already
underway — all of them, not just the first — so reprioritizing what comes next
never displaces work another agent is holding; with nothing underway it is the
same as `first`.

**Refs** point outward at other systems, where relations point at other items:

```bash
agentboard link "the auth cleanup" --wiki auth-design --rel spec --json
agentboard unlink "the auth cleanup" --wiki auth-design --json
```

Exactly one of `--wiki <slug>`, `--url <url>`, `--artifact <name>`; `--rel` is
`spec`, `notes`, or `evidence`, defaulting to `notes`.

**Removal is a tombstone**, not a delete:

```bash
agentboard rm "the duplicate capture" --reason "same as the CI work" --json
agentboard restore "the duplicate capture" --reason "not a duplicate after all" --json
```

State, rank, and event log all survive, and `restore` returns the item to the
exact rank it held. A removed item is invisible to every operational reader —
including the topic check — so re-adding the same label after an `rm` silently
succeeds and leaves you with two items the moment anyone restores the first.
Restore; do not re-add.

## Handing the board to a human

```bash
agentboard render --out board.html --json           # one self-contained HTML file
agentboard render --out board.html --publish --json # hand it to agentwiki
agentboard export --out board.jsonl                 # full-fidelity eject
agentboard import board.jsonl --json                # into an empty board only
```

agentboard never runs an HTTP server; the human view is a static file, and
`agentboard --help` plus `agentboard brief` are what a person reads in a
terminal. `--publish` shells out to `agentwiki publish` and returns that
envelope's data as `published`. Without agentwiki on PATH it refuses with
`agentwiki_missing` and the recovery names the exact command to run later — the
file is already written. `import` refuses a non-empty board with
`board_not_empty`, so it can never merge two histories.

## Output contract

With `--json`, every outcome is one envelope on stdout:

```json
{"schema_version": 1, "ok": true, "error": null, "data": {…}}
```

| Exit | Shape | Meaning |
|---|---|---|
| 0 | `ok:true` envelope on stdout | success |
| 1 | `ok:false` with `error.{code,message,recovery?}` on stdout | domain refusal |
| 2 | no envelope; message + help on **stderr**, stdout empty | usage fault |

The split is the useful part: stdout is parseable JSON whenever a command
actually ran, and exit 2 means your command line was wrong before the board was
ever opened. Argument grammar is checked first, so a missing `--reason` or
`--agent` is exit 2 with help on stderr — not a domain error envelope.

`--jsonl` streams one record per line for `list`, `search`, `ready`, `graph`,
and `export`.

## Errors, and the move that fixes each

| `error.code` | What happened | Do this |
|---|---|---|
| `existing_topic` | An open item already covers that topic | `get` the named item and extend it; `--new` only if a second item is genuinely wanted |
| `ambiguous_ref` | The phrase named several items in one tier | `resolve <phrase> --json`, then use a longer phrase or the id it printed |
| `unknown_ref` | Nothing matched | `search` or `resolve` for near matches; capture it if it does not exist |
| `already_claimed` | Another agent holds it | Take the next item from `ready`, or ask that agent to release it |
| `not_claimable` | Not `open` — waiting, paused, or already active | `resume` it first, or pick other work |
| `not_claimed` / `not_resumable` | Nothing to release / not waiting or paused | Read `get` before transitioning |
| `terminal_item` | It is `done`, `cancelled`, or `superseded` | Capture the follow-up as a new item, or supersede this one from the new item |
| `removed_item` | It is tombstoned | `restore <ref> --reason "..."` first |
| `relation_cycle` | The edge closes a loop in one acyclic kind | Relate the other way round, or use `related-to`, which carries no direction |
| `duplicate_relation` | That edge already exists (symmetric kinds dedupe either way) | Read `get`; nothing to do |
| `unknown_relation` | No such edge to remove | `get` either item to see the edges it does carry |
| `board_not_empty` | `import` into a board with content | Point `--db` at a fresh path |
| `stale_draft` / `draft_conflict` / `groom_refused` | Grooming | See the [`groom` skill](#sibling-skills) |

## Recipes

**"Add this to the board."** Capture at whatever granularity was said; let the
topic check do its job.

```bash
agentboard add ship the CSV export --summary "..." --tag reporting --json
# existing_topic? read what is already there before forcing a second item:
agentboard get "the CSV export" --json
```

**"What should I work on?"** Ready, then claim, and say the label back.

```bash
agentboard ready --json
agentboard claim "ship the CSV export" --agent "$AGENT" --json
```

**"Why is nothing ready?"** Everything open is blocked, waiting, or paused —
`brief` says which, and `get` names the blockers.

```bash
agentboard brief --json
agentboard get "the item you expected" --json   # .blockers
```

**"Do these three next."** One call, in the order they were said.

```bash
agentboard order --id "first thing,second thing,third thing" --to next --json
```

**"This is part of that."** Containment makes one item a program without a
second type; `tree` shows the result.

```bash
agentboard relate "the checkout rewrite" contains "split the form into steps" --json
```

**"I'm stuck on something outside the board."** Park it with the reason and
keep the claim.

```bash
agentboard wait "the migration" --reason "waiting on the DBA maintenance window" --json
```

**"What's going on?"** `brief --spoken` if it will be heard, `brief --json` if
it will be read.

**"That work is finished."** Close it with a note; the note is what the next
reader gets instead of asking you.

```bash
agentboard done "ship the CSV export" --note "landed in 1.4, docs updated" --json
```

## Anti-patterns

| Don't | Do |
|---|---|
| Say or write `it-9f2a41bc` to a human | Say the label; ids are plumbing |
| Guess between two candidate items | `resolve <phrase> --json`, then use the id it printed |
| Pick work off `list` | `ready` — it is the computed, unblocked set |
| Start work, then claim it if it goes well | Claim first; the claim is what stops a collision |
| Loop `edit`/`relate` over several items | One grooming draft — the `groom` skill |
| Add a "blocked" tag or state | `depends-on` edges; blocked is computed |
| `wait` on another board item | `relate <a> depends-on <b>`; `wait` is for things off the board |
| Force `--new` past `existing_topic` | Read the existing item and extend it |
| Re-add an item you removed | `restore` — it keeps the rank and the history |
| Reopen a `done` item | Capture the follow-up; terminal is frozen |
| Parse the human lines | `--json`, and branch on `error.code` |

## Discovery and drift

The board teaches itself; prefer asking it over trusting memory:

```bash
agentboard guide --json        # the stable machine card — model, codes, commands
agentboard --agent-help        # the in-binary runbook (this skill is the deep one)
agentboard --agent-teaser      # one line
agentboard --help              # all 31 commands
agentboard <command> --help    # one command, without opening the board
```

`guide --json` is the contract: item model, every state, every relation kind,
order placements, resolution tiers, grooming rules, the envelope, the exit
codes, and the full `error_codes` list. After an agentboard upgrade, read it
and re-verify anything here that a release note touched.

## Sibling skills

- **`groom`** — bulk reshaping. Any change touching several items at once:
  merging duplicates, splitting an epic, closing a batch, re-planning a
  project. One atomic draft, never a loop of single commands.
- **`wiki`** — the linked documents. `link --wiki <slug>` points an item at a
  wiki page, and `render --publish` hands the board snapshot to agentwiki.
