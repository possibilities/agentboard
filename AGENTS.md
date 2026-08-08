# agentboard — repository guidance

Agent-first planning board: one item type at any granularity, typed relations,
computed ready-work, atomic claims, and voice-first mechanics over an embedded
SQLite database. Read `README.md` for usage, `CONTEXT.md` for the glossary —
use its canonical terms in code, comments, and commit messages.

## Commands

- `bun test` — unit tests (pure logic only; no network, no fixed home paths)
- `bun run typecheck` — `tsc --noEmit`, strict with `noUncheckedIndexedAccess`
- `bun run lint` / `bun run format` — Biome check / autofix
- `bun run check` — lint + typecheck + test, the gate for every commit

## Load-bearing decisions

- **SQLite is the source of truth** (unlike agentwiki): ready-work graph
  queries, atomic claims, and concurrent multi-agent writes are the product.
  The churn hedge is a full-fidelity `export --jsonl` / `import` eject path.
- **Ready is computed, never stored.** "Blocked" is a fact derived from
  `depends-on` edges, so it can never go stale.
- **Voice output speaks labels, never identifiers.** Ids are opaque and stay
  in tool calls; `brief --spoken` must never emit an id, hash, or path.
- **Tombstones, never deletes**, and restore returns an item to the exact
  rank it held — removal never takes an item's rank away.
- **Bulk reshaping goes through grooming drafts only**: atomic, idempotent by
  draftId, refused when stale (baseRevision) or out of declared scope.

## Conventions

- Output: `--json` emits the stable `{schema_version, ok, error, data}`
  envelope; domain failures are `ok:false` envelopes on stdout with exit 1;
  usage faults print help to stderr with exit 2 and are never envelopes.
- Errors carry a stable snake_case `code` and, where actionable, a `recovery`.
- State transitions run inside `BEGIN IMMEDIATE` transactions; every mutation
  appends to the item's event log and bumps its revision.
- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (Biome `useLiteralKeys`
  is off).
- Shared modules (`envelope.ts`, `errors.ts`, `flags.ts`, `paths.ts`) are
  copied byte-identical in the agentwiki repo; changing them here means
  porting the change there in the same working session.
