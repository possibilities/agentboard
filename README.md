# agentboard

Agent-first planning board — linear-flavored but granularity-agnostic, built for
voice-driven agents: capture, order, claim, and complete work ranging from
one-line snippets to multi-part programs, with typed links into agentwiki.

One item type at every granularity. Ids are opaque and never spoken — every
`<ref>` argument takes a label, a rough restatement of one, or any unambiguous
phrase from a label.

## Install

Requires Bun ≥ 1.3.14.

```sh
bash scripts/install.sh
```

Symlinks `~/.local/bin/agentboard` at this checkout and records the deployed sha
under `~/.local/state/agentboard/`. `scripts/install.sh --uninstall` removes the
symlink and leaves the board database alone.

## Use

`agentboard --help` lists all 32 commands. The mechanics worth knowing before
you read them:

`--to next` queues behind every item an agent is already working, not just the
first, so reprioritizing what comes next never displaces work in progress.

Capture refuses a label that names work already open and says which item it
already is — that refusal is the feature, and `--new` overrides it.

Reshaping in bulk goes through a grooming draft, which is atomic, idempotent,
and refused if the board moved underneath it:

```sh
agentboard groom export --out draft-base.json
# build a draft carrying that baseRevision, then:
agentboard groom apply draft.json
```

Handing the board to a human is a static file — agentboard never runs a server:

```sh
agentboard render --out board.html --publish   # --publish needs agentwiki on PATH
```

### For agents

```sh
agentboard --agent-teaser     # one line
agentboard --agent-help       # the runbook
agentboard guide --json       # the machine card
agentboard state              # the bearings dump; silent when the board is clear
```

`state` is the board's entry in the cross-tool `agent*` state convention: a
counts header that accounts for everything open, label-only lines for what
fits `--budget` (approximate tokens, default 400), and no output at all on a
clear board.

`--json` emits the stable `{schema_version, ok, error, data}` envelope on
stdout. Exit 0 on success, exit 1 with `ok:false` and a snake_case `error.code`
on a domain failure, exit 2 for a usage fault — which prints help on stderr and
is never an envelope, so stdout is parseable whenever a command actually ran.
`--jsonl` streams one record per line for `list`, `search`, `ready`, `graph`,
and `export`.

The board lives at `~/.local/share/agentboard/board.sqlite3`, overridable with
`--db` or `AGENTBOARD_DB`.

## Develop

```sh
bun install
bun run check        # lint + typecheck + test
bash scripts/smoke.sh   # every command against a throwaway database
```

`CONTEXT.md` is the glossary — use its terms. `docs/adr/` records the decisions
that are expensive to revisit.
