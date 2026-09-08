# Authoring a grooming draft

Read `guide` through AgentBoard MCP if the live contract differs from this
reference. Export immediately before building; do not copy IDs or revisions
from an example or an earlier conversation.

## Operations

| Operation | Fields | Meaning |
| --- | --- | --- |
| `create-item` | `tempId`, `label`, optional `title`, `summary`, `tags`, `origin` | Create an item at the end of the order; an already-open topic is refused. |
| `update-item` | `id`, plus at least one of `label`, `title`, `summary`, `tags`, `note` | Change unfinished work; this is how existing tags are changed. |
| `close-item` | `id`, terminal `state`, `reason` | Close as done, cancelled, or superseded. |
| `add-relation` | `kind`, `from`, `to`, optional `note` | Add a typed edge. |
| `remove-relation` | `kind`, `from`, `to` | Remove an edge; its full prior value is retained in the audit. |

A create's `tempId` can be used by later operations wherever an item reference
belongs. The result's `created` bindings map these handles to permanent IDs,
and an identical replay returns the original bindings.

## Scope boundaries

A scoped draft can touch its `scopeItemIds`, justified `expansions`, and items
it creates. An item cannot be both inside scope and an expansion.

Depends-on, conflicts-with, and related-to can cross the boundary with one
endpoint declared. Contains and supersedes require both endpoints because they
restate what the other item is. Every removal of a relation also requires both
endpoints to be declared.

## Validation and graph consequences

First, the whole draft is checked for shape and per-operation legality: fields,
enums, known live IDs, scope, unique temporary handles, open-topic collisions,
existing/missing edges, and edits or closure of terminal items. All violations
are returned together, before any write.

After that stage passes, graph consequences are checked. Contains, depends-on,
and supersedes must each remain acyclic. A superseded item must have a
successor, and a supersedes edge must point to an item the draft leaves
superseded. Removing its only successor relation without correcting that state
is refused. Fixing the first stage may expose a second list; neither refusal
partially applied the draft.

A board revision includes semantic item fields and relations, including
tombstones. Claims, renames, order changes, removals, and restores can therefore
make a draft stale even when they seem unrelated to its subject.

## Common restructurings

To merge duplicates, fold the useful detail into a survivor, close the duplicate
as superseded, and add the survivor-to-duplicate supersedes edge in the same
draft. Both closure and edge are required.

To split work, create children using temporary handles and relate them to the
parent with contains. Keep the parent open as the umbrella when work remains.

To close a batch, give every close operation the reason that made it moot and
put the shared decision in the draft summary. Use cancelled when no successor
took over.

[`example-draft.json`](../example-draft.json) is a historical applied example.
Its IDs, revision, and draft identity belong to that board and must not be
reused. Copy its shape only; every existing-item reference comes from the fresh
export.

## Limits and audit

Drafts cannot reorder, claim/release, wait/pause/resume, remove/restore items,
or add outward refs. They omit tombstones and cannot update or close terminal
items. There is no draft equivalent of forcing a duplicate open topic.

A replan is usually one draft for structure followed by one order operation for
priority. The stored audit retains the applied operations, removed relations,
and temporary-ID bindings. No manual database or audit editing is needed.
