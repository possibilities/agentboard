#!/usr/bin/env bun

/**
 * Entry point. Three exits, and which one a caller gets is part of the
 * contract: 0 for success, 1 for a domain refusal (an ok:false envelope under
 * --json), and 2 for a usage fault, which prints help on stderr and is never an
 * envelope — so an agent can rely on stdout being parseable whenever a command
 * actually ran.
 */

import { type PreparedCommand, parseCommand, runPrepared, servePrepared } from "./cli.ts";
import { SCHEMA_VERSION } from "./contract.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";

function emit(body: string): void {
  if (body.length > 0) console.log(body);
}

/** Global flags a caller may put before the command name as well as after. */
const HOISTABLE = { value: new Set(["--db"]), bool: new Set(["--json", "--jsonl"]) };

/**
 * Lift leading global flags off the front of argv so `agentboard --db X list`
 * and `agentboard list --db X` are the same command. They are re-appended after
 * the command's own arguments; naming one twice is a duplicate-flag usage
 * fault, which is the honest answer rather than a silent winner.
 */
function hoistGlobals(argv: string[]): { globals: string[]; rest: string[] } {
  const globals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (HOISTABLE.bool.has(flag) && equals === -1) {
      globals.push(argument);
      index++;
      continue;
    }
    if (HOISTABLE.value.has(flag)) {
      globals.push(argument);
      index++;
      if (equals === -1 && index < argv.length) globals.push(argv[index++]!);
      continue;
    }
    break;
  }
  return { globals, rest: argv.slice(index) };
}

/** A number when the command returns an outcome; a promise while a serving
 * command holds the process. */
function main(raw: string[]): number | Promise<number> {
  const { globals, rest: argv } = hoistGlobals(raw);
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    emit(TOP_HELP);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    emit(VERSION);
    return 0;
  }
  if (command === "--agent-help") {
    emit(AGENT_HELP);
    return 0;
  }
  if (command === "--agent-teaser") {
    emit(AGENT_TEASER);
    return 0;
  }

  const rest = [...argv.slice(1), ...globals];
  // Asking for a command's help must never open the board or fail on a missing
  // required flag: it is the thing a caller reaches for when the flags are wrong.
  if (rest.includes("--help") || rest.includes("-h")) {
    const text = HELP[command];
    if (text === undefined) {
      console.error(`unknown command "${command}"`);
      return 2;
    }
    emit(text);
    return 0;
  }

  // Parsed before anything runs, so success and failure agree on the output
  // mode: a raw argv scan disagrees with the grammar after `--`, and used to
  // print a JSON envelope for a failure whose success would have been human.
  let prepared: PreparedCommand;
  try {
    prepared = parseCommand(command, rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(HELP[command] ?? TOP_HELP);
    return 2;
  }

  const { flags } = prepared;
  const json = flags.bools.has("json");
  try {
    const home = homeDirectory();
    // A serving command has no outcome to print: it holds the process until its
    // transport closes, and its own failures go to stderr because stdout is
    // that transport.
    const serving = servePrepared(prepared, process.env, home);
    if (serving !== undefined) {
      return serving.then(
        () => 0,
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`agentboard ${command}: ${detail}`);
          return 1;
        },
      );
    }
    const { output, close } = runPrepared(prepared, process.env, home);
    try {
      if (json) {
        emit(JSON.stringify(success(SCHEMA_VERSION, output.data)));
      } else if (flags.bools.has("jsonl") && output.lines !== undefined) {
        for (const record of output.lines) console.log(JSON.stringify(record));
      } else {
        emit(output.human);
      }
    } finally {
      close();
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(HELP[command] ?? TOP_HELP);
      return 2;
    }
    const domain =
      error instanceof CliError
        ? error
        : new CliError("internal_error", error instanceof Error ? error.message : String(error));
    if (json) {
      emit(JSON.stringify(failure(SCHEMA_VERSION, domain)));
    } else {
      emit(`error: ${domain.message}`);
      if (domain.recovery !== undefined) emit(`  → ${domain.recovery}`);
    }
    return 1;
  }
}

function homeDirectory(): string {
  const home = process.env["HOME"];
  if (home === undefined || home.length === 0) {
    throw new CliError("no_home", "HOME is unset, so the default board path cannot be resolved");
  }
  return home;
}

const outcome = main(process.argv.slice(2));
if (typeof outcome === "number") process.exit(outcome);
else void outcome.then((code) => process.exit(code));
