# agentboard — repository guidance

Agent-first planning board: one item type at any granularity, typed relations,
computed ready-work, atomic claims, and voice-first mechanics over an embedded
SQLite database. Read `README.md` for usage, `CONTEXT.md` for the glossary —
use its canonical terms in code, comments, and commit messages.

## Commands

`package.json` has the scripts; `bun run check` is the gate for every commit.
The one that is not in there: `bash scripts/smoke.sh` runs all 31 commands end
to end against a throwaway board.

## Map

`src/` splits into a pure half that never sees a database and a storage half
that owns every write. A new module that needs both is usually two modules.

- Pure, tested without a database: `topic.ts`, `state.ts`, `order.ts`,
  `graph.ts`, `resolve.ts`, `brief.ts`
- Storage: `schema.ts`, `db.ts`, `store.ts` (the `Board` class — every read,
  every mutation, the audit trail), `groom.ts`
- Surface: `main.ts` (exit codes, envelope printing), `cli.ts` (the command
  table; one function per command, no printing), `format.ts`, `render.ts`,
  `help.ts`, `guide.ts`

`help.ts` and `guide.ts` are the human help and the machine card; the command
table, `COMMANDS`, and `HELP` must name the same commands, and a test pins it.

`envelope.ts`, `errors.ts`, `flags.ts`, and `paths.ts` are copied
byte-identical in the agentwiki repo; changing one here means porting the change
there in the same working session.

## Load-bearing decisions

`docs/adr/` records them, one file each: SQLite is the source of truth, one
item type, ready is computed, grooming drafts are the bulk path, and "next"
queues behind work underway.

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
- `order --to next` queues behind the **last** item that is underway (`active`),
  not the first, so reprioritizing never displaces work a second agent holds.
- Single-item edits are `edit`; anything that touches several items at once is a
  grooming draft. Grooming is the only *bulk* path, not the only write path.
- Comments state constraints the code can't show; no narration.
- `Record<string, unknown>` access uses bracket keys (Biome `useLiteralKeys`
  is off).
- Tests use temp directories and temp databases only.
