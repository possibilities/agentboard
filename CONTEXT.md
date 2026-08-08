# Glossary

**Item** — the single unit of work, at any granularity: a one-line snippet, a bug, a multi-part
program. There is deliberately no second type. _Avoid_: task, ticket, issue, epic.

**Label** — an item's short speakable name; the voice surface. Voice output uses labels, never
identifiers. _Avoid_: name.

**Title** — the readable display variant of a label, for terminal and rendered views.

**Topic key** — the normalized form of a label ("the auth cleanup" ≡ "Auth cleanup") used to
point a new capture at an existing open item instead of forking a duplicate.

**Order** — the single dense priority rank across all live items. Order is priority and nothing
else; it survives state changes, tombstoning, and restore. _Avoid_: position, index.

**Ready** — the computed set: open items whose `depends-on` blockers are all closed, in order.
Never a stored state — "blocked" is a fact derived from the graph. _Avoid_: unblocked.

**Claim** — an atomic take of an item by one agent; a second claim is refused, not queued.
_Avoid_: assign (claims are taken, not given).

**Relation** — a typed edge between items: `contains`, `depends-on`, `conflicts-with`,
`supersedes`, `related-to`. Acyclic kinds are validated on write. _Avoid_: link (reserved for
outward references).

**Ref** — an outward reference from an item to another system: `wiki:<slug>`, an artifact name,
or a URL, carrying a rel (`spec | notes | evidence`). _Avoid_: attachment.

**Grooming draft** — the sole bulk-mutation path: an atomic, idempotent (draftId),
staleness-checked (baseRevision) operation set with declared scope. _Avoid_: batch edit.

**Tombstone** — the removal marker; nothing is silently deleted, and restore returns an item to
the exact rank it held. _Avoid_: delete (as a verb for what `rm` does).

**Brief** — the summary of the board, spoken or read; structurally guaranteed to mention every
open item, so silence can only mean the board is truly empty. _Avoid_: status dump.
