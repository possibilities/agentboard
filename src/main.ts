#!/usr/bin/env bun

/**
 * Entry point. Three exits, and which one a caller gets is part of the
 * contract: 0 for success, 1 for a domain refusal (an ok:false envelope under
 * --json), and 2 for a usage fault, which prints help on stderr and is never an
 * envelope — so an agent can rely on stdout being parseable whenever a command
 * actually ran.
 */

import { runCommand } from "./cli.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import { AGENT_HELP, AGENT_TEASER, HELP, TOP_HELP, VERSION } from "./help.ts";

export const SCHEMA_VERSION = 1;

function emit(body: string): void {
  if (body.length > 0) console.log(body);
}

function main(argv: string[]): number {
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

  const rest = argv.slice(1);
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

  const json = rest.includes("--json");
  try {
    const { output, flags, close } = runCommand(command, rest, process.env, homeDirectory());
    try {
      if (flags.bools.has("json")) {
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

process.exit(main(process.argv.slice(2)));
