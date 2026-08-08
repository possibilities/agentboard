# 0004 — Grooming drafts are the sole bulk-mutation path

An agent reshaping a backlog reads it, reasons about the whole of it, and then
writes. Between the read and the write the board can move, and a half-applied
reshaping is worse than none — so bulk change is one reviewed artifact rather
than a stream of commands: atomic, idempotent by `draftId`, refused when its
`baseRevision` no longer matches, and refused when it touches anything outside
the scope it declared without saying why.

Single-item commands stay single-item on purpose. Anything that would need to
loop over items belongs in a draft, where the audit row records the operations
as applied, the full snapshot of every removed relation, and how each `tempId`
resolved.
