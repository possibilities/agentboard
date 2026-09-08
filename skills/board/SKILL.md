---
name: board
description: >-
  Capture, prioritize, claim, and complete work on the agentboard planning
  board. Use for work tracking, next-task selection, and status; use groom for
  bulk restructuring of multiple items.
---

# Board — shared work with honest ownership

Use AgentBoard's MCP tools through Executor. Discover the `agentboard`
namespace, describe the selected tool, and use `guide` for the current item
model, states, argument constraints, and recovery codes. The installed contract
is authoritative; tool names below are catalog names, not shell commands.

The board is shared state. A claim records who is doing the work; a terminal
state records what actually happened. Keep both accurate.

## Read, claim, work, close

1. Use `ready` to find open, unblocked work in priority order. `list` is an
   inventory and may include work whose dependencies are unfinished.
2. Read the selected item with `get`, including its blockers and existing claim.
3. Call `claim` before starting, using a stable identity that distinguishes this
   agent from other concurrent agents. A matching identity makes a repeated
   claim idempotent; another owner's claim is a refusal, not permission to join.
4. Perform the authorized work. On completion, call `done` with a useful note.
   Record an external blocker with `wait`, or a deliberate set-aside with `pause`.

Example argument shapes, after describing the corresponding tools:

```json
{"ref":"the login cleanup","agent":"release-check"}
```

```json
{"ref":"the login cleanup","note":"Fixed the failure and verified the release build."}
```

Use the first with `claim`, the second with `done`. Claims are atomic. Only open
items are claimable; `release` clears a claim and returns the item to open.
`wait` and `pause` retain ownership. `resume` returns a waiting or paused item to
active if claimed, otherwise open. Read before changing an unexpected state.

Close honestly: `done` means complete, `cancel` records why work will not happen,
and `supersede` identifies the successor. Terminal states are frozen. Capture a
follow-up as a new item.

## Capture and resolve intent

Speak labels to the human. Returned item IDs are exact tool references and
belong in machine evidence when needed; do not read them aloud or require the
human to supply one. Resolution tries exact ID, exact label/title, normalized
topic, then a phrase in a label. On ambiguity, use `resolve` and select from the
returned candidates instead of guessing.

`add` takes a label plus optional summary, title, tags, and origin. An
`existing_topic` refusal means an open item already covers that topic: read and
extend it. Use the `new` option only when the user intends a distinct item with
the same topic. `edit` changes one item's label, title, or summary; tags on an
existing item require a grooming draft.

Use the **groom** skill for bulk restructuring. One `order` call can sequence a
whole named run; several items rewritten by repeated single-item mutations
lose the atomicity of a draft.

## Read and shape the board

- `brief` groups underway, ready, blocked, waiting, and paused work. Its `spoken`
  option produces labels suitable for voice. `state` is a compact bearings
  summary; an empty result means no unfinished work.
- `get` explains one item's state and blockers; `events` reads its history.
  `search` includes finished live items, while `list` normally shows unfinished
  work. Operational readers omit tombstones.
- `contains` makes larger work out of ordinary items. `depends-on` records
  board dependencies; blocked is computed, never a stored state or tag.
  `waiting` describes a blocker outside the board.
- `order` changes priority without changing state, claims, or dependencies.
  `next` places work after every active item, preserving other agents' work.
- `link` attaches one wiki slug, URL, or artifact as notes, a spec, or evidence.
  Use the **wiki** skill for the linked document itself.

The [board model and recovery reference](references/board-model.md) explains
relations, ordering, tombstones, and uncommon refusals.

## Share a reviewable view

Use `render` with an explicit absolute `out` path to create the static HTML
view. The MCP server's working directory is not the task's directory. Set
`publish` only when publication is authorized. Rendering may write the file
before publication fails; inspect the result before retrying.

The operator's full backup/restore commands are outside the agent MCP catalog.
Use `graph` for a full board read and `groom_export` for a restructuring base.
Do not access the live SQLite file to work around a refused tool call.

## Interpret results

Check Executor's outer `ok`, then the MCP result's structured envelope
`{schema_version, ok, error, data}`. If the envelope is in a text content block,
parse that standalone JSON rather than the human explanation. On an Executor
MCP error it may be preserved under `error.details.content`. Read the inner
`error.code` and `recovery` before another call.

`already_claimed` means another agent owns the item; select other ready work or
coordinate with that agent. `ambiguous_ref` needs a more precise reference.
`terminal_item` needs a new follow-up. If a mutation's outcome is unknown,
re-read the item and its events before deciding whether a retry is needed.
