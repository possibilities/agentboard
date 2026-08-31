/**
 * The contract → MCP mapping, whole, in one file.
 *
 * `agentstart/config/agent-contract/MCP.md` is the normative specification and
 * this module implements exactly it: which leaves become tools, how names and
 * input schemas are built, how each constraint maps, how the annotations are
 * derived, what the server's instructions carry, and how a tool call becomes a
 * CLI invocation. Nothing here decides which commands an agent may call — the
 * contract already answered that in `audience`, and a mapper that second-guessed
 * it would have moved the decision back to the consumer.
 *
 * Six sibling CLIs carry the same mapping, so it is deliberately dull. The only
 * agentboard-specific judgments are the two annotation facts the contract cannot
 * state, and they are marked where they appear.
 *
 * Nothing in here imports the MCP SDK: the mapping is a description of tools,
 * and `mcp-server.ts` is what hands that description to a server.
 */

import * as z from "zod/v4";
import { type ContractArgument, type ContractCommand, constraintSentence } from "./contract.ts";
import type { ParsedFlags } from "./flags.ts";

/** The half of `guide --json` this mapping reads, named so it can be read. */
export interface ContractDocument {
  meta: { name: string; version: string; purpose: string };
  guidance: string;
  global_arguments: ContractArgument[];
  commands: ContractCommand[];
  concepts: {
    output_contract: { envelope: Record<string, string> };
    error_codes: { code: string; meaning: string; recovery?: string }[];
    agent_defaults: string[];
  };
}

/** The four hints MCP carries. Declared here rather than imported so this file
 * stays SDK-free; the shape is `ToolAnnotations` and is checked structurally. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface AgentTool {
  /** The command's full path joined with `_`, never prefixed with the CLI name:
   * the host already namespaces by server. */
  name: string;
  /** The same path unjoined — the dispatcher needs the segments. */
  path: string[];
  title: string;
  description: string;
  /** Advertised as JSON Schema and used to validate the call. */
  input: z.ZodObject<Record<string, z.ZodType>>;
  annotations: ToolAnnotations;
  /** Exactly the arguments the schema above exposes — the leaf's own plus any
   * `call` global. Held so invoking reads the same set the schema advertised. */
  arguments: ContractArgument[];
  leaf: ContractCommand;
}

// --- Which commands become tools ---

/**
 * Exactly the leaves whose `audience` is `agent`: not groups, which are not
 * invocable, and not `operator` or `internal` — `mcp` itself included.
 *
 * The leaf's own audience decides, never its group's. A group is a help
 * heading; the judgment about who may call a verb is made on the verb.
 */
function agentLeaves(
  commands: ContractCommand[],
  prefix: string[] = [],
): { path: string[]; leaf: ContractCommand }[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    if (command.subcommands !== undefined) return agentLeaves(command.subcommands, path);
    return command.audience === "agent" ? [{ path, leaf: command }] : [];
  });
}

// --- Input schema ---

/**
 * `--tag` → `tag`, `ref` → `ref`. A flag and a positional differing only by the
 * dashes would collide; no fleet contract has that pair, and the dispatcher
 * looks each argument back up by its contract name, so nothing depends on this
 * spelling beyond being typeable.
 */
function propertyName(name: string): string {
  return name.replace(/^--/, "");
}

/** MCP.md: a `ref` stays a string, and the caller is told that a label or an
 * unambiguous phrase resolves — otherwise it hunts for an id it never needs. */
const REF_NOTE =
  "Accepts an item id, its label, or any unambiguous phrase from one; ids are opaque and are never the normal way to name an item. Call resolve when a phrase could name two.";

/** MCP.md: an `out` path is a destination the command writes, and the caller
 * did not choose the working directory a relative one resolves against. */
const OUT_PATH_NOTE =
  "The command WRITES this path. A relative path resolves against a working directory this caller did not choose, and an existing file is overwritten.";

/**
 * Said even when the authored description already says it. The mapping has to
 * GUARANTEE the caller is told how a csv argument is spelled; a mapper that
 * first checks whether the prose says it is one that silently stops saying it
 * the day the prose is reworded.
 */
function csvNote(argument: ContractArgument): string {
  return argument.format === "ref"
    ? "Comma-joined into one string, each entry an item reference."
    : "Comma-joined into one string.";
}

function propertyDescription(argument: ContractArgument): string {
  const parts = [argument.description];
  if (argument.format === "ref") parts.push(REF_NOTE);
  if (argument.csv === true) parts.push(csvNote(argument));
  if (argument.format === "path" && argument.direction === "out") parts.push(OUT_PATH_NOTE);
  return parts.join(" ");
}

/**
 * The contract's four scalars, verbatim. `choices` becomes an enum — the fleet
 * has no non-string choice list, and a numeric one would need its own branch
 * rather than a coercion that quietly changed the type.
 */
function scalar(argument: ContractArgument): z.ZodType {
  if (argument.type === "boolean") return z.boolean();
  if (argument.choices !== undefined) return z.enum(argument.choices as [string, ...string[]]);
  if (argument.type === "string") return z.string();
  let numeric = argument.type === "integer" ? z.number().int() : z.number();
  if (argument.minimum !== undefined) numeric = numeric.min(argument.minimum);
  if (argument.maximum !== undefined) numeric = numeric.max(argument.maximum);
  return numeric;
}

function property(argument: ContractArgument): z.ZodType {
  // `repeatable` without `csv` is an array of the scalar; `repeatable` AND
  // `csv` is also an array, and is comma-joined when invoked.
  const base = argument.repeatable === true ? z.array(scalar(argument)) : scalar(argument);
  const described = base.describe(propertyDescription(argument));
  // A default makes the property optional in the input schema on its own, which
  // is why it is checked before `required`.
  if (argument.default !== undefined) return described.default(argument.default as never);
  return argument.required === true ? described : z.optional(described);
}

/**
 * A leaf's own arguments, plus the globals whose `role` is `call`.
 *
 * Everything else is suppressed: `output-format`, `store-selection` and `meta`
 * are concerns the caller has already fixed, and asking a model to choose `--db`
 * is asking it to guess. In agentboard that suppresses all four globals.
 */
function callArguments(document: ContractDocument, leaf: ContractCommand): ContractArgument[] {
  const globals = document.global_arguments.filter(
    (argument) => (argument.role ?? "call") === "call",
  );
  return [...(leaf.arguments ?? []), ...globals];
}

// --- Constraints ---

/**
 * Expressed in the schema where JSON Schema can, and in the description ALWAYS.
 * A schema-only rule is invisible in most host UIs, and a caller that cannot see
 * a rule breaks it.
 *
 * Zod cannot express a cross-field rule, so the schema keywords are injected
 * through its metadata, which the SDK's converter merges into the emitted JSON
 * Schema. They are advisory either way: the command itself is the enforcement,
 * and duplicating its checks here would be the second authorship this contract
 * exists to delete.
 */
interface MappedConstraints {
  keywords: Record<string, unknown>;
  sentences: string[];
}

/** `oneOf`/`anyOf` of single-property `required` shapes, per MCP.md. */
function eitherOf(members: string[]): { required: string[] }[] {
  return members.map((member) => ({ required: [member] }));
}

function mapConstraints(leaf: ContractCommand): MappedConstraints {
  const keywords: Record<string, unknown> = {};
  const sentences: string[] = [];
  for (const constraint of leaf.constraints ?? []) {
    // Said in the CLI's own words, with the arguments spelled as the properties
    // this schema advertises rather than as flags.
    sentences.push(constraintSentence(constraint, propertyName));
    const members = constraint.arguments.map(propertyName);
    switch (constraint.kind) {
      case "one_of":
        // Nothing in JSON Schema says "at most one" without `not`, which is
        // legal and unreadable in practice; there the sentence is the whole
        // mapping.
        if (constraint.required === true) keywords["oneOf"] = eitherOf(members);
        break;
      case "at_least_one":
        keywords["anyOf"] = eitherOf(members);
        break;
      case "requires":
        keywords["dependentRequired"] = { [members[0]!]: members.slice(1) };
        break;
      case "conflicts":
        // Expressible as `not`/`allOf` and unreadable as either; described only.
        break;
    }
  }
  return { keywords, sentences };
}

// --- Annotations ---

/**
 * Verbs that remove or overwrite. MCP.md derives `destructiveHint` from
 * `mutates` plus the verb, and the verb is the one thing it cannot read off a
 * field — so the list is here, once, rather than a hint per command.
 */
const REMOVING_VERBS = new Set([
  "rm",
  "remove",
  "delete",
  "destroy",
  "gc",
  "prune",
  "purge",
  "clear",
  "unlink",
  "unrelate",
]);

/**
 * Full paths whose repeat call is NOT a no-op. Every other agentboard mutation
 * refuses a duplicate rather than appending one, so replaying it with the same
 * arguments leaves the board where it was — which is what MCP.md calls
 * idempotent. `add` is the exception: with `--new` it captures another item on
 * every call. A sibling lists its own appending verbs here.
 */
const APPENDING: ReadonlySet<string> = new Set(["add"]);

/**
 * Full paths that reach the network. Empty for agentboard: `render --publish`
 * hands the file to agentwiki on this machine, and is operator-audience anyway.
 * A sibling that fetches lists those paths here.
 */
const NETWORK: ReadonlySet<string> = new Set<string>();

/**
 * The two lists above, exported for the test that pins them against the
 * contract: a list naming a command nobody has is a list that has rotted, and
 * an annotation is the one place where nothing else would notice.
 */
export const ANNOTATION_EXCEPTIONS: {
  appending: ReadonlySet<string>;
  network: ReadonlySet<string>;
} = {
  appending: APPENDING,
  network: NETWORK,
};

function annotations(path: string[], leaf: ContractCommand): ToolAnnotations {
  const full = path.join(" ");
  const writesOut = (leaf.arguments ?? []).some(
    (argument) => argument.format === "path" && argument.direction === "out",
  );
  return {
    readOnlyHint: leaf.mutates === false,
    destructiveHint: leaf.mutates === true && (REMOVING_VERBS.has(leaf.name) || writesOut),
    idempotentHint: !APPENDING.has(full),
    openWorldHint: NETWORK.has(full),
  };
}

// --- Description ---

function toolDescription(
  document: ContractDocument,
  path: string[],
  leaf: ContractCommand,
  sentences: string[],
): string {
  const parts: string[] = [];
  // MCP.md: a blocking command says so in the FIRST sentence, because a host
  // with a request timeout has no other way to know. A command that spends
  // money or quota owes the same warning; the contract has no field for cost,
  // so a sibling whose command bills says it in that leaf's own `guidance`,
  // which lands below.
  if (leaf.blocking === true) {
    parts.push("Blocks: this waits on something outside the CLI and may not return promptly.");
  }
  parts.push(`${leaf.summary}.`);
  // The guidance below quotes CLI invocations; this is what makes them legible.
  parts.push(`Runs \`${document.meta.name} ${path.join(" ")}\` in this process.`);
  parts.push(...sentences);
  if (leaf.guidance !== undefined) parts.push(leaf.guidance);
  return parts.join("\n\n");
}

// --- The surface ---

export function agentTools(document: ContractDocument): AgentTool[] {
  return agentLeaves(document.commands).map(({ path, leaf }) => {
    const exposed = callArguments(document, leaf);
    const shape: Record<string, z.ZodType> = {};
    for (const argument of exposed) {
      shape[propertyName(argument.name)] = property(argument);
    }
    const { keywords, sentences } = mapConstraints(leaf);
    return {
      name: path.join("_"),
      path,
      title: leaf.summary,
      description: toolDescription(document, path, leaf, sentences),
      input: z.object(shape).meta(keywords),
      annotations: annotations(path, leaf),
      arguments: exposed,
      leaf,
    };
  });
}

/**
 * The server's `instructions`: the contract's `guidance`, then what `concepts`
 * says a caller must know — the envelope, the error codes with their recovery,
 * and `agent_defaults`. This is the half of the contract a tool schema cannot
 * carry, and dropping it ships a surface that works and is used wrongly.
 *
 * Exit codes are the one part of the output contract left out: there is no
 * process to exit here, and a refusal arrives as a tool error instead.
 */
export function serverInstructions(document: ContractDocument): string {
  const envelope = Object.entries(document.concepts.output_contract.envelope)
    .map(([field, meaning]) => `  ${field}: ${meaning}`)
    .join("\n");
  const errors = document.concepts.error_codes
    .map((entry) =>
      entry.recovery === undefined
        ? `  ${entry.code} — ${entry.meaning}`
        : `  ${entry.code} — ${entry.meaning} → ${entry.recovery}`,
    )
    .join("\n");
  const defaults = document.concepts.agent_defaults.map((line) => `  ${line}`).join("\n");
  return `${document.guidance}

Every tool returns ${document.meta.name}'s own envelope as JSON text:
${envelope}

A refusal comes back as a tool error whose first line is the error code, then
the message, then the recovery when there is one. The recovery line is the
difference between a caller that retries correctly and one that retries
identically, so read it before calling again.

Error codes
${errors}

Opening moves
${defaults}
`;
}

// --- Invoking ---

/**
 * A tool call, as the CLI's own dispatcher takes it. There is no argv: the
 * arguments go straight into the shape the parser would have produced, so
 * nothing is re-parsed and nothing is quoted.
 */
export interface Invocation {
  /** The top-level command the dispatch table is keyed by. */
  name: string;
  flags: ParsedFlags;
}

function flagValue(argument: ContractArgument, value: unknown): string {
  if (!Array.isArray(value)) return String(value);
  if (argument.csv === true) return value.map(String).join(",");
  // MCP.md maps a `repeatable` flag without `csv` to an array of scalars, which
  // a CLI invokes by repeating the flag. agentboard's parser refuses a repeated
  // flag and its contract declares no such argument, so there is nothing here to
  // marshal into; a sibling that has one extends this branch rather than
  // silently passing the first value.
  throw new Error(`${argument.name} is repeatable without csv, which this CLI cannot invoke`);
}

/**
 * Tool arguments → the parsed flags the command's handler reads.
 *
 * Positionals go in declaration order, behind the path segments below the
 * top-level command: a group is dispatched by reading its subcommand off the
 * front of the positionals, exactly as argv would have delivered it. An
 * optional positional declared before a required one would shift the rest, but
 * that is true of the CLI too, and no fleet contract declares one.
 */
export function invocationFor(tool: AgentTool, args: Record<string, unknown>): Invocation {
  const positional: string[] = [...tool.path.slice(1)];
  const values: Record<string, string> = {};
  const bools = new Set<string>();

  for (const argument of tool.arguments) {
    const value = args[propertyName(argument.name)];
    if (value === undefined) continue;
    if (argument.positional === true) {
      positional.push(flagValue(argument, value));
      continue;
    }
    // An absent boolean flag and one passed as false are the same call.
    if (argument.type === "boolean") {
      if (value === true) bools.add(propertyName(argument.name));
      continue;
    }
    values[propertyName(argument.name)] = flagValue(argument, value);
  }

  return { name: tool.path[0]!, flags: { values, bools, positional } };
}
