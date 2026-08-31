# agentboard — repository guidance

Agent-first planning board: one item type at any granularity, typed relations,
computed ready-work, atomic claims, and voice-first mechanics over an embedded
SQLite database. Read `README.md` for usage, `CONTEXT.md` for the glossary —
use its canonical terms in code, comments, and commit messages.

## Commands

`package.json` has the scripts; `bun run check` is the gate for every commit.
The one that is not in there: `bash scripts/smoke.sh` runs all 32 commands end
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

## Agent skills

`skills/board/SKILL.md` (driving the board) and `skills/groom/SKILL.md` (bulk
reshaping through drafts) are the canonical deep runbooks — the advertised ones,
since every agent session lists an installed skill's name and description. AgentStart's skills
scan copies them into the fixed private fleet resources with `npx skills add --copy`
against this checkout, which finds
them by the nested `skills/<name>/SKILL.md` layout. Each directory is
self-contained and ships separately, so neither may reference the other by path:
`skills/groom/example-draft.json` is a real draft that really applied, and the
`agents/openai.yaml` beside each `SKILL.md` is the Codex-side manifest.

`--agent-help` stays the in-binary fallback and names both skills; a test pins
that. The skills document the CLI as installed, so a change to a command's
behavior, an error code, or a refusal means re-verifying their claims against
the live CLI — writes against a throwaway `--db`, never the real board — before
editing their prose.

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

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
