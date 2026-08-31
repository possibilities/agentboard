/**
 * Conformance: `guide --json` is the fleet agent contract, version 1, and it
 * is the only authorship of this CLI's surface. Two things are pinned here —
 * that the fleet validator accepts the document, and that the document and the
 * dispatcher cannot drift apart, since the parser derives its grammar from it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

describe("the contract and the dispatcher", () => {
  test("name the same top-level commands", () => {
    expect(COMMANDS.map((command) => command.name).sort()).toEqual(
      Object.keys(COMMAND_TABLE).sort(),
    );
  });

  test("every declared flag is one the parser accepts", () => {
    for (const [name, command] of Object.entries(COMMAND_TABLE)) {
      const declared = leaves([COMMANDS.find((c) => c.name === name)!]).flatMap(
        (leaf) => leaf.command.arguments ?? [],
      );
      for (const argument of declared) {
        if (argument.positional === true) continue;
        const known = command.spec.value.has(argument.name) || command.spec.bool.has(argument.name);
        expect(`${name} ${argument.name}: ${known}`).toBe(`${name} ${argument.name}: true`);
      }
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
 * The fleet validator executes agentstart's normative schema. It is the gate;
 * a checkout without agentstart still runs the rest of this file.
 */
const AGENTSTART = process.env["AGENTSTART_HOME"] ?? join(homedir(), "code", "agentstart");
const VALIDATOR = join(AGENTSTART, "scripts", "validate-agent-contract.ts");

test.if(existsSync(VALIDATOR))("guide --json conforms to fleet contract version 1", () => {
  const guide = Bun.spawnSync(["bun", MAIN, "guide", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(guide.exitCode).toBe(0);
  const contract = join(process.env["TMPDIR"] ?? "/tmp", `agentboard-contract-${process.pid}.json`);
  Bun.write(contract, guide.stdout.toString());
  const result = Bun.spawnSync(["bun", VALIDATOR, "--file", contract], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString() + result.stdout.toString()).toContain("conforms to version 1");
  expect(result.exitCode).toBe(0);
});
