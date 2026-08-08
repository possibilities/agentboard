/**
 * The three lists that describe the command surface have to agree, and the
 * version has to be one number. Both were verified by hand until now.
 */

import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import { COMMAND_TABLE } from "../src/cli.ts";
import { COMMANDS, HELP, VERSION } from "../src/help.ts";

describe("the command surface", () => {
  const table = Object.keys(COMMAND_TABLE).sort();
  const commands = COMMANDS.map((command) => command.name).sort();
  const help = Object.keys(HELP).sort();

  test("COMMAND_TABLE and COMMANDS name the same commands", () => {
    expect(table).toEqual(commands);
  });

  test("COMMAND_TABLE and HELP name the same commands", () => {
    expect(table).toEqual(help);
  });

  test("every command has a non-empty summary and help body", () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0);
      expect((HELP[command.name] ?? "").length).toBeGreaterThan(0);
    }
  });
});

test("help.ts VERSION matches the package version", () => {
  expect(VERSION).toBe(packageJson.version);
});
