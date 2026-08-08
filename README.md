# agentboard

Agent-first planning board — linear-flavored but granularity-agnostic, built
for voice-driven agents: capture, order, claim, and complete work ranging from
one-line snippets to multi-part programs, with typed links into agentwiki.

## Install

```sh
bash scripts/install.sh
```

## Use

Landing with the build. `agentboard --agent-help` is the agent runbook;
`agentboard guide --json` is the machine-readable card.

## Develop

```sh
bun install
bun run check   # lint + typecheck + test
```
