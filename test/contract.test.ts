/**
 * Conformance: `guide --json` is the fleet agent contract, version 1, and it
 * is the only authorship of this CLI's surface. Two things are pinned here —
 * that the fleet validator accepts the document, and that the document and the
 * dispatcher cannot drift apart.
 *
 * The drift worth testing has a direction. A declared flag the parser rejects
 * is impossible: `spec()` in cli.ts IS `commandFlags()`, so asserting the two
 * agree asserts that a function equals itself. What can go wrong is the other
 * way — a handler reading `ctx.flags.values["x"]` for an `x` nothing declares,
 * which parses as a positional and silently reads undefined forever. So the
 * handlers are read, and every flag they name has to exist in the contract.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMMAND_TABLE } from "../src/cli.ts";
import {
  buildContract,
  COMMANDS,
  type ContractCommand,
  GLOBAL_ARGUMENTS,
} from "../src/contract.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

function leaves(
  commands: ContractCommand[],
  prefix: string[] = [],
): { path: string; command: ContractCommand }[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    return command.subcommands === undefined
      ? [{ path: path.join(" "), command }]
      : leaves(command.subcommands, path);
  });
}

/** `--tag` → `tag`: a handler reads the parsed name, without the dashes. */
const parsed = (name: string): string => name.replace(/^--/, "");

/** Every flag name a handler can name, in the four spellings cli.ts uses. */
const READS = [
  /flags\.values\["([\w-]+)"\]/g,
  /flags\.bools\.has\("([\w-]+)"\)/g,
  /(?:optionalValue|requireValue)\(\s*[\w.]+,\s*"([\w-]+)"\)/g,
];

function flagsRead(source: string): Set<string> {
  const found = new Set<string>();
  for (const pattern of READS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return found;
}

const CLI_SOURCE = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

/**
 * The dispatch table split into one block per command, so a read can be blamed
 * on the handler that made it. Entries sit at exactly two spaces of indent
 * between the table's opening line and the `};` that closes it; a helper called
 * from a handler falls outside every block and is covered by the whole-file
 * check instead.
 */
function handlerBlocks(source: string): Map<string, string> {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith("const COMMAND_TABLE"));
  expect(start).toBeGreaterThan(-1);
  const blocks = new Map<string, string>();
  let name: string | undefined;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "};") break;
    const opening = /^ {2}([a-z]\w*): \{$/.exec(line);
    if (opening !== null) {
      if (name !== undefined) blocks.set(name, body.join("\n"));
      name = opening[1]!;
      body = [];
    } else if (name !== undefined) {
      body.push(line);
    }
  }
  if (name !== undefined) blocks.set(name, body.join("\n"));
  return blocks;
}

const GLOBALS = new Set(GLOBAL_ARGUMENTS.map((argument) => parsed(argument.name)));

describe("the contract and the dispatcher", () => {
  test("name the same top-level commands", () => {
    expect(COMMANDS.map((command) => command.name).sort()).toEqual(
      Object.keys(COMMAND_TABLE).sort(),
    );
  });

  test("every flag a handler reads is one its own command declares", () => {
    const blocks = handlerBlocks(CLI_SOURCE);
    expect([...blocks.keys()].sort()).toEqual(Object.keys(COMMAND_TABLE).sort());
    for (const [name, body] of blocks) {
      const declared = new Set([
        ...GLOBALS,
        ...leaves([COMMANDS.find((command) => command.name === name)!])
          .flatMap((leaf) => leaf.command.arguments ?? [])
          .filter((argument) => argument.positional !== true)
          .map((argument) => parsed(argument.name)),
      ]);
      for (const flag of flagsRead(body)) {
        expect(`${name} reads --${flag}: ${declared.has(flag)}`).toBe(
          `${name} reads --${flag}: true`,
        );
      }
    }
  });

  test("every flag read anywhere in cli.ts is a flag the contract declares", () => {
    // Catches the helpers too: parsePlacement reads --to, refTarget reads
    // --wiki/--url/--artifact, and none of them sits inside a handler block.
    const declared = new Set([
      ...GLOBALS,
      ...leaves(COMMANDS)
        .flatMap((leaf) => leaf.command.arguments ?? [])
        .filter((argument) => argument.positional !== true)
        .map((argument) => parsed(argument.name)),
    ]);
    for (const flag of flagsRead(CLI_SOURCE)) {
      expect(`cli.ts reads --${flag}: ${declared.has(flag)}`).toBe(`cli.ts reads --${flag}: true`);
    }
  });

  test("every global argument is accepted by every command", () => {
    for (const command of Object.values(COMMAND_TABLE)) {
      for (const argument of GLOBAL_ARGUMENTS) {
        expect(command.spec.value.has(argument.name) || command.spec.bool.has(argument.name)).toBe(
          true,
        );
      }
    }
  });
});

describe("the contract document", () => {
  const contract = buildContract("/tmp/board.sqlite3") as any;

  test("declares version 1 and the agent audience", () => {
    expect(contract.contract_version).toBe(1);
    expect(contract.meta.audience).toBe("agent");
    expect(contract.guidance.length).toBeGreaterThan(0);
  });

  test("read_only_commands is exactly the non-mutating leaves, by full path", () => {
    const nonMutating = leaves(COMMANDS)
      .filter((leaf) => leaf.command.mutates === false)
      .map((leaf) => leaf.path);
    expect([...contract.concepts.read_only_commands].sort()).toEqual(nonMutating.sort());
    expect(contract.concepts.read_only_commands).toContain("groom export");
  });

  test("the mutation rule is stated, and export and render both obey it", () => {
    // Both write a file; only one of them writes somewhere nobody named. The
    // rule that separates them is published rather than left to be re-derived.
    expect(contract.concepts.mutation).toContain("mutates");
    const byName = (name: string) => COMMANDS.find((command) => command.name === name);
    expect(byName("export")?.mutates).toBe(false);
    expect(byName("render")?.mutates).toBe(true);
    expect(contract.concepts.read_only_commands).toContain("export");
  });

  test("every leaf declares mutates and arguments; no group does", () => {
    const walk = (commands: ContractCommand[]): void => {
      for (const command of commands) {
        if (command.subcommands === undefined) {
          expect(typeof command.mutates).toBe("boolean");
          expect(Array.isArray(command.arguments)).toBe(true);
        } else {
          expect(command.mutates).toBeUndefined();
          expect(command.arguments).toBeUndefined();
          walk(command.subcommands);
        }
      }
    };
    walk(COMMANDS);
  });
});

/**
 * The fleet validator executes agentstart's normative schema, and it is the
 * gate: this file may not pass because the gate was not found.
 *
 * It is resolved, not guessed at. AGENTSTART_HOME, else ~/code/agentstart; if
 * that checkout is absent the fleet's optional-checkout rule applies and the
 * test skips, which is the one case where quiet is correct. If the checkout is
 * there the script must be — in it, or in one of its worktrees, which is where
 * it lives while the branch carrying it is unmerged. Anything else fails,
 * naming every path tried.
 */
type Resolution = { found: string } | { uninstalled: string } | { missing: true; tried: string[] };

function resolveValidator(): Resolution {
  const home = process.env["AGENTSTART_HOME"] ?? join(homedir(), "code", "agentstart");
  if (!existsSync(home)) return { uninstalled: home };
  const script = (checkout: string) => join(checkout, "scripts", "validate-agent-contract.ts");
  const tried = [script(home)];
  if (existsSync(tried[0]!)) return { found: tried[0]! };

  const listed = Bun.spawnSync(["git", "-C", home, "worktree", "list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode === 0) {
    for (const line of listed.stdout.toString().split("\n")) {
      const checkout = line.split(" ")[0]?.trim();
      if (checkout === undefined || checkout.length === 0 || checkout === home) continue;
      const candidate = script(checkout);
      tried.push(candidate);
      if (existsSync(candidate)) return { found: candidate };
    }
  }
  return { missing: true, tried };
}

const VALIDATOR = resolveValidator();

test.if(!("uninstalled" in VALIDATOR))("guide --json conforms to fleet contract version 1", () => {
  if (!("found" in VALIDATOR)) {
    throw new Error(
      `agentstart is installed but its contract validator was not found. Tried:\n  ${(VALIDATOR as { tried: string[] }).tried.join("\n  ")}`,
    );
  }
  const guide = Bun.spawnSync(["bun", MAIN, "guide", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(guide.exitCode).toBe(0);
  const contract = join(process.env["TMPDIR"] ?? "/tmp", `agentboard-contract-${process.pid}.json`);
  try {
    Bun.write(contract, guide.stdout.toString());
    const result = Bun.spawnSync(["bun", VALIDATOR.found, "--file", contract], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString() + result.stdout.toString()).toContain("conforms to version 1");
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(contract, { force: true });
  }
});
