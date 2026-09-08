---
name: groom
description: >-
  Restructure an agentboard backlog with one atomic grooming draft. Use for
  deduplication, splitting or merging work, bulk closure, and replanning; use
  board for individual items, ordering, and routine state updates.
---

# Groom — one atomic change to a backlog

Use the `agentboard` MCP server directly. Select the tool from the harness's
catalog or tool search, inspect its input schema, and call it with JSON
arguments. The host may prefix tool names with the server name. `guide`
provides the installed command contract and recovery guidance.
Use `groom_export` and `groom_apply` for a draft. Use the **board** skill for
individual items, claims, state changes, and order.

A grooming draft captures a coherent restructuring: deduplication, splitting
work, re-parenting, batch closure, or replanning. It applies atomically against
the exact revision read, records its intent, and can be replayed safely.

## Build and apply

1. Export immediately before building the draft. `groom_export` returns
   `version`, `baseRevision`, `generatedAt`, `items`, and `relations`. It can
   optionally write an absolute `out` path.
2. Resolve the user's scope against that export. Use returned IDs for existing
   items and draft-local `tempId` values only for new items.
3. Write the draft as a local JSON file using the native file tool. Make it a
   concrete, reviewable account of the intended changes. Existing authorization
   to restructure the backlog is sufficient; do not add a second approval step.
4. Apply it with `groom_apply`, passing its absolute path as `draft`:

   ```json
   {"draft":"/absolute/task-directory/backlog-draft.json"}
   ```

5. Check the result and bindings. If priority also changes, follow with one
   `order` call containing the complete intended sequence.

The registered server must be able to read that file. A relative path resolves
against its own working directory and is not a safe task-file reference.
Several sequential edits are not a substitute for an atomic draft.

## Draft identity and scope

The draft has `version: 1`, a unique `draftId`, the exported `baseRevision`, a
`scope` instruction or null, a useful `summary`, and 1–1000 ordered operations.
A scoped draft names `scopeItemIds`; a whole-board draft must omit that field.
Any deliberate work beyond the resolved scope belongs in `expansions` as
`{id, reason}`. Do not widen scope to null just to evade a refusal.

The [draft reference](references/drafts.md) gives the five operations, boundary
rules, graph checks, and worked-example guidance. Read it before authoring the
first draft or handling a scope refusal.

## Reconcile before retrying

Inspect MCP `isError` and AgentBoard's `{schema_version, ok, error, data}`
envelope in `structuredContent`. If the host returns only content blocks,
parse the standalone JSON block and keep diagnostic prose separate. Read
`error.code` and `recovery` before retrying or claiming success.
Inspect `data.outcome` to choose the next action.

| Result | Next action |
| --- | --- |
| `applied` | Record the returned created-item bindings and result revision. |
| `already_applied` | Success; use the original bindings. Nothing changed again. |
| `stale_draft` | Re-export, reconsider the operations against current state, and use the new revision. |
| `draft_conflict` | This ID was applied with different content; a changed grooming needs a new ID. |
| `groom_refused` | Read all violations, fix the draft, and reuse the unconsumed ID. Nothing was written. |
| `unreadable_draft` | Correct the file/path or JSON; this is not a board-state problem. |

A lost response is safe to reconcile by replaying the **same content and ID**.
The digest is semantic: formatting or key order does not change it. Once an ID
was applied, different content requires a new ID. A refused draft creates no
audit row and does not consume its ID.

Keep the user informed in labels and outcomes. Exact IDs and revisions belong
in the draft, tool arguments, and technical receipts, not spoken narration.
