#!/usr/bin/env bun

const USAGE = `agentboard — agent-first planning board

The command surface lands with the build; this scaffold only wires the entry
point, shared envelope, flags, and paths modules.`;

function main(argv: string[]): number {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  console.error(`unknown command "${command}"`);
  console.error(USAGE);
  return 2;
}

process.exit(main(process.argv.slice(2)));
