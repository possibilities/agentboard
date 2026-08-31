---
name: groom
description: >-
  Reshape an agentboard board in bulk through one atomic grooming draft,
  using the agentboard CLI. Use for any change touching several items at
  once — "reorganize the board", "restructure the backlog", "merge these
  duplicates", "split this epic", "close everything about X", "re-plan the
  project", deduplicating or consolidating captured work. Several edits at
  once is one draft, never a loop of single commands: the draft declares
  the board revision it was built on and the items it may touch, then lands
  completely or writes nothing. Single-item edits and reading the board are
  the board skill.
---

# Groom — bulk reshaping through atomic drafts

An agent reshaping a backlog reads the whole of it, reasons about the whole of
it, and then writes. Between that read and that write the board can move, and a
half-applied reshaping is worse than none. So agentboard has exactly one bulk
path: a grooming draft — a reviewed artifact that is atomic, idempotent by
`draftId`, refused when the board moved underneath it, and refused when it
touches anything outside the scope it declared without saying why.

Verified against agentboard 0.1.0. The CLI is self-describing — when this
document and the installed binary disagree, the binary wins; see
[Discovery and drift](#discovery-and-drift).

## When to groom

Reach for a draft the moment a change touches **more than one item**: merging
duplicates, splitting a large item into the pieces it actually is, closing a
batch of work that a decision made moot, re-parenting a subtree, re-planning a
project after a change of direction.

The alternative — a loop of `add`, `edit`, `relate`, `done` — is worse in three
specific ways. It is not atomic, so a failure halfway leaves the board in a
shape nobody designed. It races other agents, because every command re-reads a
board that may have moved between the last one and this one. And it leaves no
record of the intent: the event log gets ten unrelated mutations instead of one
audited grooming with a summary, a scope, and every removed relation captured.

Stay with the single-item commands (the [`board` skill](#sibling-skills)) when
the change really is one item, and for everything a draft cannot express — see
[What a draft cannot do](#what-a-draft-cannot-do).

## Non-negotiables

- **Export immediately before you build.** The `baseRevision` in the export is
  the draft's ticket; a board that moved since invalidates it.
- **Never hand-write ids.** Take them from the export you just read.
- **Declare scope honestly.** If the grooming has a scope, resolve it into
  `scopeItemIds` and put anything you touch beyond it in `expansions` with a
  reason. The refusal exists to catch a groom that quietly grew.
- **One draft, one `draftId`.** Changing what a draft says means a new
  `draftId` — reusing an applied one with different content is refused.
- **Read the whole refusal.** Violations are collected, not thrown one at a
  time, and nothing is written until every one of them is gone.

## The loop

```bash
# 1. Read the board as a groomer sees it
agentboard groom export --json --out /tmp/export.json

# 2. Build the draft against that export's baseRevision and ids

# 3. Land it, all or nothing
agentboard groom apply /tmp/draft.json --json
```

`groom export` returns `{version, baseRevision, generatedAt, items,
relations}`. Items carry `id`, `label`, `title`, `topicKey`, `summary`, `tags`,
`state`, `stateReason`, `origin`, `rank`, and `claim`; relations carry `kind`,
`from`, `to`, `note`. Removed items are omitted entirely — grooming never
touches tombstones. `groom export` is read-only and safe to run anytime.

## Draft anatomy

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1` |
| `draftId` | yes | Your identity for this grooming; the idempotency key |
| `baseRevision` | yes | Copied verbatim from the export |
| `scope` | yes | Free-form scope instruction, or `null` for a whole-board grooming |
| `scopeItemIds` | with a scope | The resolution of `scope` into exact ids; forbidden when `scope` is `null` |
| `expansions` | optional | `[{id, reason}]` — items touched beyond the scope, each justified |
| `summary` | yes | What this grooming does and why, in prose |
| `operations` | yes | 1–1000 operations, applied in order |

A draft's identity is its **content**, not its bytes: the digest is computed
over the normalized draft, so reformatting or reordering keys changes nothing,
while changing what it says changes everything.

## The five operations

| `op` | Fields | Notes |
|---|---|---|
| `create-item` | `tempId`, `label`, `title?`, `summary?`, `tags?`, `origin?` | Refused if an open item already holds that topic |
| `update-item` | `id`, and one of `label`, `title`, `summary`, `tags`, `note` | The only way to change an existing item's tags |
| `close-item` | `id`, `state` (`done`/`superseded`/`cancelled`), `reason` | A reason is always required |
| `add-relation` | `kind`, `from`, `to`, `note?` | `contains`, `depends-on`, `conflicts-with`, `supersedes`, `related-to` |
| `remove-relation` | `kind`, `from`, `to` | The removed relation is captured in full in the audit |

`tempId` is a draft-local handle: a `create-item` names one, and any later
operation may use it wherever an `id` goes, so a single draft can create an
item and immediately relate to it. The apply returns the bindings —
`created: [{tempId, id}]` — and stores them, so a replay reports the same ids
it minted the first time.

Created items are appended at the **end** of the board's order. If the new
shape also implies a new sequence, follow the apply with one
`agentboard order --id "a,b,c" --to next` call.

## Scope honesty

A scoped draft may freely touch the items in `scopeItemIds` and anything it
creates. For relations the rule is about what an edge asserts:

- `depends-on`, `conflicts-with`, `related-to` may cross the boundary with
  **one** endpoint declared — a dependency reaching outside the groomed set is
  exactly what a scoped grooming must stay able to record.
- `contains` and `supersedes` restate what the far item *is*, so **both**
  endpoints must be declared. So does every `remove-relation`, because removing
  an edge restructures both ends.

Anything else you deliberately touch goes in `expansions` with a reason. An id
cannot appear in both `scopeItemIds` and `expansions` — an expansion is by
definition beyond the scope.

## Two validation stages

Everything is judged before anything is written, in two passes:

1. **Shape and per-operation legality** — unknown fields, bad enums, unknown or
   removed ids, out-of-scope touches, duplicate `tempId`s, a `create-item` that
   would duplicate an open topic, an edge that already exists or does not,
   `update-item`/`close-item` against an item that is already terminal. All of
   these are collected and reported together.
2. **Graph-level consequences**, which run only once stage 1 is clean: a
   `contains`/`depends-on`/`supersedes` loop the draft would close; an item
   closed as `superseded` with nothing superseding it; a `supersedes` edge
   whose target the draft leaves open; a removal that would leave a superseded
   item superseded by nothing.

Because stage 2 waits for stage 1, fixing the first list can reveal a second.
Nothing was written either time.

## Replay, conflict, staleness

| Situation | Result | Move |
|---|---|---|
| Same `draftId`, same content | `ok:true`, `outcome: already_applied`, exit 0 — changes nothing, returns the original `appliedAt` and bindings | Nothing. A crashed apply is safe to retry |
| Same `draftId`, different content | `draft_conflict` | A changed draft is a new grooming: give it a new `draftId` |
| Board moved since the export | `stale_draft` | Re-export and rebase the draft on the new `baseRevision` and ids |
| Any violation | `groom_refused`, nothing written, no audit row | Fix the operations and apply **the same `draftId`** again |

`already_applied` is a **success**, not a refusal — check `data.outcome`, not
just `ok`. And because a refused draft leaves no audit row, the same `draftId`
is still free after a `groom_refused`; only an applied one is taken.

The board revision is a digest over every item's semantic fields and every
relation, tombstones included. A claim, a rename, a reorder, a removal, or a
restore between export and apply all make a draft stale.

## A worked example

[`example-draft.json`](example-draft.json) is a real draft, applied to a real
board. Its scenario: a checkout rewrite captured as one vague item, the same
timeout bug captured twice, and a legacy-page deletion the rewrite makes moot.
It does all of that in one landing:

- **creates** two children with `tempId`s `steps` and `gateway`, and
  **contains** them under the rewrite — the item becomes a program by growing
  edges, not by changing type;
- **depends-on** from `gateway` to an item outside the scope (the payment
  gateway rollout), which is legal with one declared endpoint;
- **merges the duplicates**: `update-item` folds the detail into the survivor,
  `close-item` closes the copy as `superseded`, and a `supersedes` edge records
  which item took over. Both halves are required — closing as superseded with
  no successor is refused, and so is a `supersedes` edge whose target stays
  open;
- **removes** the stale `contains` edge to the legacy page and **cancels** it.

Applied against the board it was built for:

```console
$ agentboard groom apply example-draft.json --json
{"schema_version":1,"ok":true,"error":null,"data":{"outcome":"applied",
 "draftId":"checkout-reshape-2026-08-08",
 "resultRevision":"br1-9d3fd2f89c8894dff771a839879482b8668293900df4ac27406cdce3ea484c26",
 "counts":{"created":2,"updated":1,"closed":2,"relationsAdded":4,"relationsRemoved":1},
 "created":[{"tempId":"steps","id":"it-035f4d19"},{"tempId":"gateway","id":"it-d0bbad55"}]}}

$ agentboard groom apply example-draft.json --json      # replayed
{"schema_version":1,"ok":true,"error":null,"data":{"outcome":"already_applied",
 "draftId":"checkout-reshape-2026-08-08","appliedAt":"2026-08-08T21:41:06.222Z",
 "created":[{"tempId":"steps","id":"it-035f4d19"},{"tempId":"gateway","id":"it-d0bbad55"}]}}
```

Copy the file's **shape**, never its values: the `baseRevision` and every
`it-…` id belong to the export it was built against and will be stale and
unknown on any other board. Yours come from your own `groom export`.

## What a draft cannot do

Grooming carries five operations and no more. It cannot reorder the board
(`agentboard order` already moves a whole dictated run in one call), claim or
release, `wait`/`pause`/`resume`, remove or restore items, or add outward refs
(`agentboard link`). It never touches tombstoned items, and it reshapes open
work only — `update-item` and `close-item` both refuse an item that is already
terminal. A `create-item` cannot duplicate a topic that is already open; there
is no draft equivalent of `add --new`.

A typical re-plan is therefore one draft for the shape, followed by one `order`
call for the sequence.

## Errors, and the move that fixes each

| `error.code` | Meaning | Do this |
|---|---|---|
| `stale_draft` | `baseRevision` is not the current board revision | `groom export` again, rebase the operations onto the new ids, re-apply |
| `draft_conflict` | That `draftId` was applied with different content | Give this grooming a new `draftId` |
| `groom_refused` | Malformed, or illegal against the current board | Read every bullet in the message; fix them all; re-apply the same `draftId` |
| `unreadable_draft` | The file is not JSON | Fix the file — this is not a board problem |
| `already_applied` (not an error) | Exit 0, `ok:true` | Nothing; the bindings in `data.created` are the real ids |

## Recipes

**Merge duplicates.** Pick the item carrying the better detail as the survivor,
fold the other's content in, close the copy as `superseded`, and record the
edge — all in one draft:

```json
{"op": "update-item", "id": "<survivor>", "summary": "…", "note": "absorbed the duplicate capture"},
{"op": "close-item", "id": "<copy>", "state": "superseded", "reason": "the same work as \"<survivor label>\""},
{"op": "add-relation", "kind": "supersedes", "from": "<survivor>", "to": "<copy>"}
```

**Split an epic.** Create the pieces with `tempId`s and hang them off the
parent with `contains`; leave the parent open as the umbrella:

```json
{"op": "create-item", "tempId": "part-one", "label": "…"},
{"op": "add-relation", "kind": "contains", "from": "<parent>", "to": "part-one"}
```

**Bulk close.** One `close-item` per item, each with the reason that made it
moot, and a `summary` naming the decision behind them all. Use `cancelled` for
work that will not happen, and `superseded` only when you also add the edge
saying what took over.

**Re-plan a project.** Scope the draft to that project's items, reshape in one
apply, then sequence what the reshape created:

```bash
agentboard groom apply replan.json --json
agentboard order --id "first,second,third" --to next --json
```

## Anti-patterns

| Don't | Do |
|---|---|
| Loop `edit`/`relate`/`done` over several items | One draft — atomic, audited, race-free |
| Build a draft from a stale export | Export immediately before building |
| Reuse an applied `draftId` for changed content | New content, new `draftId` |
| Retry a `groom_refused` under a fresh `draftId` | Fix the operations; the old id is still free |
| Treat `already_applied` as a failure | It is exit 0; read `data.created` for the ids |
| Widen `scope` to `null` to dodge a scope refusal | Add an `expansions` entry with the honest reason |
| Close an item as `superseded` with no successor | Add the `supersedes` edge, or close it `done`/`cancelled` |
| Hand-write ids or invent tempIds for existing items | Ids from the export; `tempId`s only for items this draft creates |
| Expect a draft to reorder the board | One `agentboard order --id "a,b,c" --to …` after the apply |

## Discovery and drift

```bash
agentboard guide --json        # .concepts.grooming — operations, close states, limits, scope and staleness rules
agentboard groom --help        # the command's own contract
agentboard --agent-help        # the in-binary runbook (this skill is the deep one)
```

`guide --json` carries the operation set, `close_states`, `operation_limit`,
and the exact wording of the scope, idempotency, and staleness rules. Read it
after an agentboard upgrade and re-verify anything here that changed.

Every applied grooming is kept: `agentboard export` includes the audit rows —
the operations as applied, the full snapshot of every removed relation, and how
each `tempId` resolved.

## Sibling skills

- **`board`** — everything single-item and everything read-only: `ready`,
  `brief`, `get`, `claim`, `done`, `add`, `edit`, `relate`, `order`, `link`,
  `rm`/`restore`. Reach for it first; come here when the change is plural.
