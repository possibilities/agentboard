/**
 * Help text, rendered — never authored. Every line below comes out of the
 * contract in `contract.ts`: `--help` orients a person, `--agent-help` is the
 * runbook, `--agent-teaser` is one line, and `guide --json` is the same
 * document as data. There is nothing here for a command's semantics to drift
 * away from, because there is no second copy of them.
 */

import {
  buildContract,
  COMMANDS,
  type ContractArgument,
  type ContractCommand,
  constraintSentence,
  ENTRYPOINT_FLAGS,
  GLOBAL_ARGUMENTS,
  VERSION,
} from "./contract.ts";

export { VERSION };

const WIDTH = 84;

/** The document with no database behind it: help never resolves a board path. */
const CONTRACT = buildContract("") as {
  meta: { purpose: string };
  guidance: string;
  concepts: {
    ref_resolution: { accepts: string };
    output_contract: { exit_codes: Record<string, string>; envelope: Record<string, string> };
    error_codes: { code: string; meaning: string; recovery?: string }[];
  };
};

/** "Agent-first planning board: ..." → the banner half, said in lower case. */
const TAGLINE = (() => {
  const head = CONTRACT.meta.purpose.split(":")[0]!;
  return head.charAt(0).toLowerCase() + head.slice(1);
})();

/** Hard newlines and leading indentation in authored prose are kept: a guidance
 * block's example lines are indented on purpose. */
function wrap(text: string, indent: number, width = WIDTH): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const pad = " ".repeat(indent) + (paragraph.match(/^ */)?.[0] ?? "");
    let line = "";
    for (const word of paragraph.split(" ").filter((w) => w.length > 0)) {
      if (line.length === 0) line = word;
      else if (pad.length + line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(pad + line);
        line = word;
      }
    }
    lines.push(pad + line);
  }
  return lines.join("\n").replace(/[ \t]+$/gm, "");
}

function placeholder(argument: ContractArgument): string {
  if (argument.type === "boolean") return "";
  if (argument.choices !== undefined) return argument.choices.join("|");
  if (argument.format === "path") return "<path>";
  if (argument.format === "ref") return "<ref>";
  if (argument.format === "url") return "<url>";
  if (argument.type === "integer" || argument.type === "number") return "<n>";
  return `<${argument.name.replace(/^--/, "")}>`;
}

function flagToken(argument: ContractArgument): string {
  const value = placeholder(argument);
  return value === "" ? argument.name : `${argument.name} ${value}`;
}

/**
 * `agentboard link <ref> (--wiki <wiki> | --url <url> | --artifact <artifact>)`
 * — a required one_of is a choice in the usage line, not three optionals.
 */
function usage(path: string[], command: ContractCommand): string {
  const args = command.arguments ?? [];
  const grouped = new Set<string>();
  const groups: string[] = [];
  for (const constraint of command.constraints ?? []) {
    if (constraint.kind !== "one_of") continue;
    const members = args.filter((argument) => constraint.arguments.includes(argument.name));
    if (members.length < 2) continue;
    for (const member of members) grouped.add(member.name);
    const body = members.map(flagToken).join(" | ");
    groups.push(constraint.required === true ? `(${body})` : `[${body}]`);
  }

  const positionals = args.filter((argument) => argument.positional === true);
  const flags = args.filter(
    (argument) => argument.positional !== true && !grouped.has(argument.name),
  );
  const token = (argument: ContractArgument): string =>
    argument.required === true ? flagToken(argument) : `[${flagToken(argument)}]`;

  const tokens = [
    "agentboard",
    ...path,
    ...positionals.filter((a) => a.required === true).map((a) => `<${a.name}>`),
    ...flags.filter((a) => a.required === true).map(flagToken),
    ...groups,
    ...flags.filter((a) => a.required !== true).map(token),
    ...positionals.filter((a) => a.required !== true).map((a) => `[<${a.name}>]`),
  ];

  // One long usage line is unreadable; continuations hang under the command.
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    const next = line === "" ? token : `${line} ${token}`;
    if (next.length + 2 <= WIDTH) line = next;
    else {
      lines.push(line);
      line = `    ${token}`;
    }
  }
  lines.push(line);
  return lines.join("\n  ");
}

/** A term and its description, in two columns — the description dropping to
 * its own line whenever the term is too wide to leave a gap. */
function definition(head: string, detail: string, column: number): string {
  const body = wrap(detail, column).slice(column);
  return head.length + 3 <= column
    ? `  ${head.padEnd(column - 2)}${body}`
    : `  ${head}\n${" ".repeat(column)}${body}`;
}

function argumentLine(argument: ContractArgument): string {
  const head = argument.positional === true ? `<${argument.name}>` : flagToken(argument);
  const notes: string[] = [];
  if (argument.required === true) notes.push("required");
  if (argument.csv === true) notes.push("comma-joined, one value");
  if (argument.repeatable === true) notes.push("repeatable");
  if (argument.minimum !== undefined) notes.push(`at least ${argument.minimum}`);
  if (argument.maximum !== undefined) notes.push(`at most ${argument.maximum}`);
  if (argument.default !== undefined) notes.push(`default: ${String(argument.default)}`);
  return definition(head, [argument.description, ...notes.map((n) => `(${n})`)].join(" "), 26);
}

function commandHelp(path: string[], command: ContractCommand): string {
  const headline = command.summary.charAt(0).toLowerCase() + command.summary.slice(1);
  const lines = [`agentboard ${path.join(" ")} — ${headline}`, "", "Usage:"];
  if (command.subcommands === undefined) {
    lines.push(`  ${usage(path, command)}`);
  } else {
    for (const sub of command.subcommands) lines.push(`  ${usage([...path, sub.name], sub)}`);
  }

  const bodies = command.subcommands ?? [command];
  for (const body of bodies) {
    const args = body.arguments ?? [];
    const heading = command.subcommands === undefined ? "Arguments:" : `Arguments (${body.name}):`;
    if (args.length > 0) {
      lines.push("", heading, ...args.map(argumentLine));
    }
    // A relation between arguments is stated once, in `constraints`; the usage
    // line can only show a required one_of, so the rest are said here.
    const constraints = body.constraints ?? [];
    if (constraints.length > 0) {
      lines.push("", ...constraints.map((c) => wrap(constraintSentence(c), 0)));
    }
    if (body.guidance !== undefined) lines.push("", wrap(body.guidance, 0));
  }
  if (command.guidance !== undefined && command.subcommands !== undefined) {
    lines.push("", wrap(command.guidance, 0));
  }
  return `${lines.join("\n")}\n`;
}

export const HELP: Record<string, string> = Object.fromEntries(
  COMMANDS.map((command) => [command.name, commandHelp([command.name], command)]),
);

function commandLines(indent: string, commands: ContractCommand[], marks: boolean): string[] {
  const lines: string[] = [];
  for (const command of commands) {
    const mark = marks && command.audience !== "agent" ? `  [${command.audience}]` : "";
    lines.push(`${indent}${command.name.padEnd(10)} ${command.summary}${mark}`);
    if (command.subcommands !== undefined) {
      lines.push(...commandLines(`${indent}  `, command.subcommands, marks));
    }
  }
  return lines;
}

const GLOBAL_LINES = [
  ...GLOBAL_ARGUMENTS.map((argument) => ({
    flag:
      argument.aliases === undefined
        ? flagToken(argument)
        : `${flagToken(argument)}, ${argument.aliases.join(", ")}`,
    meaning: argument.description,
  })),
  ...ENTRYPOINT_FLAGS,
].map((entry) => definition(entry.flag, entry.meaning, 20));

export const TOP_HELP = `agentboard — ${TAGLINE}

Usage:
  agentboard [global options] <command> [options]

Global options may go before or after the command name; the last three are
recognized only before it.

Global options:
${GLOBAL_LINES.join("\n")}

Commands:
${commandLines("  ", COMMANDS, false).join("\n")}

${wrap(CONTRACT.concepts.ref_resolution.accepts, 0)}

Run agentboard --agent-help for the agent runbook.
`;

export const AGENT_TEASER = CONTRACT.meta.purpose;

const ERROR_LINES = CONTRACT.concepts.error_codes.map((entry) =>
  definition(
    entry.code,
    entry.recovery === undefined ? entry.meaning : `${entry.meaning} → ${entry.recovery}`,
    28,
  ),
);

const EXIT_LINES = Object.entries(CONTRACT.concepts.output_contract.exit_codes).map(
  ([code, meaning]) => `  exit ${code}  ${meaning}`,
);

export const AGENT_HELP = `agentboard — ${TAGLINE} (agent runbook)

${CONTRACT.guidance}

Commands
${commandLines("  ", COMMANDS, true).join("\n")}

Output contract
  With --json every outcome is one envelope on stdout:
  {schema_version, ok, error: {code,message,recovery?} | null, data}
${EXIT_LINES.join("\n")}

Error codes
${ERROR_LINES.join("\n")}

Full contract, as data: agentboard guide --json
`;
