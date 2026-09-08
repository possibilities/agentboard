# Board model and recovery

The `guide` MCP tool is the authority for the full schema. This reference
explains the choices a caller makes rather than duplicating its flag catalog.

## Items, order, and relations

Every granularity uses one item type. A snippet becomes a larger program by
acquiring `contains` edges, not by changing type. Labels are speakable; titles
are display variants. Normalized topic keys detect recapture of open work.
States are open, active, waiting, paused, done, superseded, and cancelled.

Rank is one dense order across all rows, including terminal and removed items.
`order` accepts the comma-separated references in `id`, a `to` placement of
first/next/last/after, and an `anchor` for after. Preserve the supplied sequence
in one call. With nothing active, next and first coincide.

Relations are contains, depends-on, conflicts-with, supersedes, and related-to.
Conflicts-with and related-to are symmetric: reversing one does not create a
second edge. Contains, depends-on, and supersedes are
acyclic separately; a cycle mixing relation kinds is not automatically refused.
A `relation_cycle` refusal calls for correcting the model, not forcing the edge.

An outward reference names exactly one wiki slug, URL, or artifact. Its
relation is notes, spec, or evidence. It is separate from an edge between board
items.

## Removal and frozen state

`rm` creates a tombstone. State, rank, claim information, and history survive.
`restore` restores that existing record. Re-adding its label while it is hidden
can create a duplicate that reappears when the original is restored.

Done, cancelled, and superseded are terminal. Do not reopen or update them to
record a follow-up. A supersession records which successor took over; it is not
a synonym for cancellation.

## Refusals

| Code | Recovery |
| --- | --- |
| `existing_topic` | Read the existing item and extend it; an intentional second topic needs the explicit `new` option. |
| `ambiguous_ref` / `unknown_ref` | Resolve or search, then use a returned exact reference. |
| `already_claimed` | Respect the owner; take other ready work or coordinate a release. |
| `not_claimable` | Read state and claim; resume waiting/paused work only when its reason has cleared. |
| `not_claimed` / `not_resumable` | Re-read before another transition. |
| `terminal_item` | Capture the follow-up as a new item. |
| `removed_item` | Restore the existing item when intended. |
| `duplicate_relation` / `unknown_relation` | Read the actual edges before changing them. |
| `stale_draft` / `draft_conflict` / `groom_refused` | Follow the groom skill and the full structured refusal. |

A successful `get` includes readiness and blockers. Use them to explain why
work cannot start. Use labels in the explanation, retaining exact IDs only in
tool arguments and technical receipts.

## Rendering and storage

A render is a static HTML file; AgentBoard does not start a web server.
Publishing delegates to AgentWiki. If `agentwiki_missing` is returned, the HTML
may already exist: keep it and use the returned recovery after publication is
available and authorized.

The deployed server's database is chosen by its host configuration. Database
paths and output-format flags are process settings, not MCP call arguments.
Tests use a separate process and temporary database; ordinary work uses the
registered service rather than an ad hoc database override.
