/**
 * The MCP server `agentboard mcp` serves, constructed but not connected.
 *
 * Two things make this a generated surface rather than a second one. The tools
 * come from `guide --json` through `mcp-tools.ts`, so adding a command to
 * `contract.ts` adds a tool with no edit here. And every call is dispatched
 * through `cli.ts`'s own `COMMAND_TABLE`, in this process — the same function
 * `agentboard add` runs, reached with the same parsed flags, with nothing
 * spawned and no argv re-parsed.
 *
 * `mcp.ts` is the entrypoint that connects a transport to what this returns.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runPrepared } from "./cli.ts";
import { buildContract, SCHEMA_VERSION, VERSION } from "./contract.ts";
import { failure, success } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import {
  type AgentTool,
  agentTools,
  type ContractDocument,
  invocationFor,
  serverInstructions,
} from "./mcp-tools.ts";
import type { Environ } from "./paths.ts";

export interface ServerOptions {
  env: Environ;
  home: string;
  /** The board every tool call uses, resolved once when the server starts.
   * `--db` is an operator's choice about which board is being served, which is
   * exactly why it is not a tool argument. */
  dbPath: string;
}

export function createAgentboardMcpServer(options: ServerOptions): McpServer {
  const document = buildContract(options.dbPath) as unknown as ContractDocument;
  const server = new McpServer(
    { name: document.meta.name, version: VERSION },
    { instructions: serverInstructions(document) },
  );
  for (const tool of agentTools(document)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      // The SDK infers the callback's argument type from the input schema, which
      // is built at runtime and so infers to nothing useful. The shape is
      // whatever the schema just validated: a plain object of argument values.
      (args: unknown) => callTool(tool, (args ?? {}) as Record<string, unknown>, options),
    );
  }
  return server;
}

/**
 * One tool call, dispatched in process.
 *
 * The board is opened for the call and closed after it, exactly as a terminal
 * invocation would: a resident handle would hold a connection open across a
 * server's whole lifetime for no gain, and every mutation already takes its
 * lock inside its own transaction.
 */
function callTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  options: ServerOptions,
): CallToolResult {
  try {
    const invocation = invocationFor(tool, args);
    // The served board is put back where the parser would have left it, so
    // `runPrepared` resolves the same path a terminal `--db` would have.
    invocation.flags.values["db"] = options.dbPath;
    const { output, close } = runPrepared(invocation, options.env, options.home);
    try {
      const envelope = success(SCHEMA_VERSION, output.data);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
    } finally {
      close();
    }
  } catch (error) {
    return toolError(error);
  }
}

/**
 * A refusal, as MCP.md rules: the message leads with `error.code`, then the
 * message, then `recovery` when the contract gives one — the recovery line is
 * the difference between a caller that retries correctly and one that retries
 * identically. The envelope follows, so anything already parsing agentboard
 * parses the same shape here.
 *
 * A usage fault is not an envelope anywhere: at a terminal it is exit 2 with
 * help on stderr and no `error.code` at all. It comes back here as a plain tool
 * error for that reason — inventing a forty-fourth code would be a code the
 * contract lists and the CLI cannot emit.
 */
function toolError(error: unknown): CallToolResult {
  if (error instanceof UsageError) {
    return { isError: true, content: [{ type: "text", text: `invalid call: ${error.message}` }] };
  }
  const domain =
    error instanceof CliError
      ? error
      : new CliError("internal_error", error instanceof Error ? error.message : String(error));
  const lines = [`${domain.code}: ${domain.message}`];
  if (domain.recovery !== undefined) lines.push(`recovery: ${domain.recovery}`);
  lines.push(JSON.stringify(failure(SCHEMA_VERSION, domain), null, 2));
  return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}
