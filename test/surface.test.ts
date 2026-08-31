/**
 * The command surface is one list now — the contract's — and the help text is
 * rendered from it. What is left to pin is that the rendering actually happens:
 * every command reachable from the dispatcher has help, and the version is one
 * number.
 */

import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import { COMMAND_TABLE } from "../src/cli.ts";
import { COMMANDS } from "../src/contract.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "../src/help.ts";

describe("the command surface", () => {
  const table = Object.keys(COMMAND_TABLE).sort();

  test("COMMAND_TABLE and the contract name the same commands", () => {
    expect(table).toEqual(COMMANDS.map((command) => command.name).sort());
  });

  test("every command renders help, and the top-level help lists it", () => {
    for (const command of COMMANDS) {
      expect((HELP[command.name] ?? "").length).toBeGreaterThan(0);
      // The header says the summary in lower case; the top-level list says it as written.
      expect(HELP[command.name]?.toLowerCase()).toContain(command.summary.toLowerCase());
      expect(TOP_HELP).toContain(command.summary);
    }
    expect(Object.keys(HELP).sort()).toEqual(table);
  });

  test("the runbook renders the guidance and the error codes", () => {
    expect(AGENT_HELP).toContain("Ids are opaque");
    expect(AGENT_HELP).toContain("existing_topic");
    expect(AGENT_TEASER.split("\n")).toHaveLength(1);
  });
});

test("help.ts VERSION matches the package version", () => {
  expect(VERSION).toBe(packageJson.version);
});

// The skills are the advertised runbooks and ship from skills/; agent-help
// points at them, so an agent that only ever reads the binary still finds them.
test("the agent runbook names both agent skills", () => {
  expect(AGENT_HELP).toContain("`board`");
  expect(AGENT_HELP).toContain("`groom`");
});
