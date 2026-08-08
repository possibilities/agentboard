# agentboard — repository guidance

Agent-first planning board: one item type at any granularity, typed relations,
computed ready-work, atomic claims, and voice-first mechanics over an embedded
SQLite database. Read `README.md` for usage, `CONTEXT.md` for the glossary —
use its canonical terms in code, comments, and commit messages.

## Commands

- `bun test` — unit tests (pure logic and temp databases; no network, no fixed
  home paths)
- `bun run typecheck` — `tsc --noEmit`, strict with `noUncheckedIndexedAccess`
- `bun run lint` / `bun run format` — Biome check / autofix
- `bun run check` — lint + typecheck + test, the gate for every commit
- `bash scripts/smoke.sh` — every command end to end against a throwaway board

## Map

`src/` splits into a pure half that never sees a database and a storage half
that owns every write. A new module that needs both is usually two modules.

- `src/main.ts` — entry point: global flags, exit codes, envelope printing
- `src/cli.ts` — the command table; one function per command, no printing
- `src/types.ts` — the vocabulary: states, relation kinds, the `Item` record
- Pure logic, tested without a database:
  - `topic.ts` — topic keys (`topicKeyFor`) and label normalization
  - `state.ts` — transition legality and reason requirements
  - `order.ts` — placement and dense reranking (`placeItems`)
  - `graph.ts` — canonical edges, cycle detection, containment forest, `ready`
  - `resolve.ts` — ref resolution tiers and candidate ranking
  - `brief.ts` — the grouped brief and the spoken variant
- Storage:
  - `schema.ts` — DDL and the version this code writes
  - `db.ts` — path resolution, pragmas, the migration ladder
  - `store.ts` — the `Board` class: every read, every mutation, the audit trail
  - `groom.ts` — draft parsing, validation, and atomic apply
- Presentation: `format.ts` (terminal), `render.ts` (static HTML), `help.ts`
  (`--help` / `--agent-help`), `guide.ts` (`guide --json`)

`envelope.ts`, `errors.ts`, `flags.ts`, and `paths.ts` are copied
byte-identical in the agentwiki repo; changing one here means porting the change
there in the same working session.

## Load-bearing decisions

See `docs/adr/`. In short:

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
- Argument grammar is validated before the board is opened, so a missing flag
  is a usage fault whether or not the reference would have resolved.
- Errors carry a stable snake_case `code` and, where actionable, a `recovery`.
- State transitions run inside `BEGIN IMMEDIATE` transactions; every mutation
  appends to the item's event log and bumps its revision.
- Ranks are dense over *every* row, tombstones and terminal items included, and
  are only ever rewritten as a whole permutation — never patched in place.
- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (Biome `useLiteralKeys`
  is off).
- Tests use temp directories and temp databases only.
