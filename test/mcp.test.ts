/**
 * The generated MCP surface.
 *
 * Two halves, and both matter. The mapping is checked in process against
 * `mcp-tools.ts` — what becomes a tool, what is suppressed, and how each
 * constraint lands in the schema. Then a real `agentboard mcp` is spawned and
 * driven over stdio by a real MCP client: initialize, tools/list, tools/call.
 * A mapping that is only unit-tested is a mapping that has never once been
 * spoken to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z4mini from "zod/v4-mini";
import { buildContract, type ContractCommand } from "../src/contract.ts";
import {
  ANNOTATION_EXCEPTIONS,
  agentTools,
  type ContractDocument,
  serverInstructions,
} from "../src/mcp-tools.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

const DOCUMENT = buildContract("/tmp/agentboard-mcp-test.sqlite3") as unknown as ContractDocument;
const TOOLS = agentTools(DOCUMENT);

function leaves(
  commands: ContractCommand[],
  prefix: string[] = [],
): { path: string; leaf: ContractCommand }[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    return command.subcommands === undefined
      ? [{ path: path.join(" "), leaf: command }]
      : leaves(command.subcommands, path);
  });
}

const LEAVES = leaves(DOCUMENT.commands);

/** The advertised JSON Schema, as a host sees it after the SDK converts. */
function schemaOf(name: string): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return z4mini.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

describe("which commands become tools", () => {
  test("exactly the agent leaves, and every one of them", () => {
    const wanted = LEAVES.filter(({ leaf }) => leaf.audience === "agent").map(({ path }) =>
      path.replace(/ /g, "_"),
    );
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...wanted].sort());
    expect(wanted.length).toBe(30);
  });

  test("no operator or internal leaf is exposed, mcp included", () => {
    const exposed = new Set(TOOLS.map((tool) => tool.name));
    const hidden = LEAVES.filter(({ leaf }) => leaf.audience !== "agent");
    expect(hidden.map(({ path }) => path).sort()).toEqual(["export", "import", "mcp", "render"]);
    for (const { path } of hidden) expect(exposed.has(path.replace(/ /g, "_"))).toBe(false);
  });

  test("mcp declares itself internal, mutating, and blocking", () => {
    const mcp = DOCUMENT.commands.find((command) => command.name === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.audience).toBe("internal");
    expect(mcp?.mutates).toBe(true);
    expect(mcp?.blocking).toBe(true);
  });

  test("a nested leaf is named by its full path, joined with an underscore", () => {
    expect(TOOLS.map((tool) => tool.name)).toContain("groom_export");
    expect(TOOLS.map((tool) => tool.name)).toContain("groom_apply");
    // Never prefixed with the CLI name: the host namespaces by server.
    expect(TOOLS.every((tool) => !tool.name.startsWith("agentboard"))).toBe(true);
  });
});

describe("the input schema", () => {
  test("every global is suppressed, because none of them is a call knob", () => {
    for (const global of DOCUMENT.global_arguments) {
      expect(global.role ?? "call").not.toBe("call");
    }
    const property = (name: string) => name.replace(/^--/, "");
    for (const tool of TOOLS) {
      const properties = Object.keys(schemaOf(tool.name)["properties"] ?? {});
      for (const global of DOCUMENT.global_arguments) {
        expect(properties).not.toContain(property(global.name));
      }
    }
  });

  test("a ref stays a string and says a label resolves", () => {
    const schema = schemaOf("get") as {
      properties: Record<string, { type: string; description: string }>;
    };
    expect(schema.properties["ref"]?.type).toBe("string");
    expect(schema.properties["ref"]?.description).toContain("label");
    expect(schema.properties["ref"]?.description).toContain("unambiguous phrase");
  });

  test("a csv argument stays a string and says so, and its element is described", () => {
    const add = schemaOf("add") as {
      properties: Record<string, { type: string; description: string }>;
    };
    expect(add.properties["tag"]?.type).toBe("string");
    expect(add.properties["tag"]?.description).toContain("Comma-joined");

    const order = schemaOf("order") as {
      properties: Record<string, { type: string; description: string }>;
    };
    expect(order.properties["id"]?.type).toBe("string");
    expect(order.properties["id"]?.description).toContain("each entry an item reference");
  });

  test("choices become an enum, a default becomes a default, a bound becomes a bound", () => {
    const add = schemaOf("add") as { properties: Record<string, Record<string, unknown>> };
    expect(add.properties["origin"]?.["enum"]).toEqual(["human", "agent"]);
    expect(add.properties["origin"]?.["default"]).toBe("human");
    const state = schemaOf("state") as { properties: Record<string, Record<string, unknown>> };
    expect(state.properties["budget"]?.["type"]).toBe("integer");
    expect(state.properties["budget"]?.["minimum"]).toBe(60);
  });

  test("an out path warns that the command writes it", () => {
    const schema = schemaOf("groom_export") as {
      properties: Record<string, { description: string }>;
    };
    expect(schema.properties["out"]?.description).toContain("WRITES");
  });
});

describe("constraints", () => {
  test("a required one_of becomes oneOf, and is said in the description", () => {
    expect(schemaOf("link")["oneOf"]).toEqual([
      { required: ["wiki"] },
      { required: ["url"] },
      { required: ["artifact"] },
    ]);
    const link = TOOLS.find((tool) => tool.name === "link");
    expect(link?.description).toContain("Give exactly one of wiki, url, artifact.");
  });

  test("at_least_one becomes anyOf, and is said in the description", () => {
    expect(schemaOf("edit")["anyOf"]).toEqual([
      { required: ["label"] },
      { required: ["title"] },
      { required: ["summary"] },
    ]);
    const edit = TOOLS.find((tool) => tool.name === "edit");
    expect(edit?.description).toContain("Give at least one of label, title, summary.");
  });

  test("a rule conditioned on another argument's value is carried as prose", () => {
    // `order`'s anchor is required only when --to is `after`, which no schema
    // keyword can say; the contract says it in the argument's description.
    const order = schemaOf("order") as { properties: Record<string, { description: string }> };
    expect(order.properties["anchor"]?.description).toContain("Required with --to after");
  });
});

describe("annotations", () => {
  const annotationsOf = (name: string) =>
    TOOLS.find((tool) => tool.name === name)?.annotations ?? {};

  test("readOnlyHint is the contract's own mutates judgment", () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(tool.leaf.mutates === false);
    }
    expect(annotationsOf("ready")).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  test("a removing verb is destructive and a capture is not", () => {
    expect(annotationsOf("rm")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf("add")).toMatchObject({ destructiveHint: false, idempotentHint: false });
  });

  test("nothing here reaches the network", () => {
    for (const tool of TOOLS) expect(tool.annotations.openWorldHint).toBe(false);
  });

  test("the mapping's exception lists name commands that exist", () => {
    // The two hints the contract cannot state are lists of exceptions rather
    // than a hint per command, so nothing else would notice one going stale.
    const paths = new Set(TOOLS.map((tool) => tool.path.join(" ")));
    for (const path of ANNOTATION_EXCEPTIONS.appending) expect(paths.has(path)).toBe(true);
    for (const path of ANNOTATION_EXCEPTIONS.network) expect(paths.has(path)).toBe(true);
  });
});

describe("the server's instructions", () => {
  const instructions = serverInstructions(DOCUMENT);

  test("carry the guidance, the envelope, every error code, and the opening moves", () => {
    expect(instructions).toContain("Ids are opaque");
    expect(instructions).toContain("schema_version");
    for (const entry of DOCUMENT.concepts.error_codes) {
      expect(instructions).toContain(entry.code);
      if (entry.recovery !== undefined) expect(instructions).toContain(entry.recovery);
    }
    for (const line of DOCUMENT.concepts.agent_defaults) expect(instructions).toContain(line);
  });
});

/**
 * The round trip. A real server process, a real client, a real handshake — the
 * one thing that cannot be faked by agreeing with the mapping module.
 */
describe("a live stdio server", () => {
  let directory: string;
  let client: Client;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentboard-mcp-"));
    client = new Client({ name: "agentboard-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [MAIN, "mcp", "--db", join(directory, "board.sqlite3")],
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("initialize names the CLI and hands back the contract's instructions", () => {
    expect(client.getServerVersion()?.name).toBe("agentboard");
    expect(client.getInstructions() ?? "").toContain("Ids are opaque");
  });

  test("tools/list is exactly the agent leaves the mapping generated", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    expect(tools.map((tool) => tool.name)).toContain("groom_export");
    expect(tools.map((tool) => tool.name)).not.toContain("mcp");
    expect(tools.map((tool) => tool.name)).not.toContain("render");
  });

  test("a read-only tool returns the CLI's own envelope", async () => {
    const result = (await client.callTool({ name: "ready", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError ?? false).toBe(false);
    const envelope = JSON.parse(result.content[0]!.text);
    expect(envelope).toMatchObject({ schema_version: 1, ok: true, error: null });
    expect(envelope.data).toMatchObject({ items: [], count: 0 });
  });

  test("a mutating tool writes the board the server was started against", async () => {
    const added = (await client.callTool({
      name: "add",
      arguments: { label: "the auth cleanup", tag: "auth,security" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(added.isError ?? false).toBe(false);
    expect(JSON.parse(added.content[0]!.text).data).toMatchObject({
      label: "the auth cleanup",
      tags: ["auth", "security"],
    });

    // Resolved by phrase, not by the id the caller was never given.
    const got = (await client.callTool({
      name: "get",
      arguments: { ref: "auth cleanup" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(got.isError ?? false).toBe(false);
    expect(JSON.parse(got.content[0]!.text).data.title).toBe("the auth cleanup");
  });

  test("a nested tool dispatches through its group", async () => {
    const result = (await client.callTool({ name: "groom_export", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]!.text).data).toHaveProperty("baseRevision");
  });

  test("a refusal leads with its code and carries its recovery", async () => {
    const result = (await client.callTool({
      name: "add",
      arguments: { label: "the auth cleanup" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text.startsWith("existing_topic:")).toBe(true);
    expect(text).toContain("recovery: ");
    expect(text).toContain("--new");
    expect(JSON.parse(text.slice(text.indexOf("{")))).toMatchObject({ ok: false });
  });

  test("a usage fault comes back as an invalid call, not as an error code", async () => {
    const result = (await client.callTool({
      name: "edit",
      arguments: { ref: "auth cleanup" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toStartWith("invalid call: ");
  });
});
