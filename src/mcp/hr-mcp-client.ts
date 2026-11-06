import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { Tool } from '../tools.js';
import { mcpInputSchemaToGemini } from './schema-convert.js';

/**
 * MCP client that connects Steve to the HR Department server.
 *
 * Responsibilities:
 * - Spawn the HR server as a child process over stdio (the transport owns it).
 * - Discover the server's tools dynamically with listTools().
 * - Wrap each MCP tool in the agent's existing `Tool` interface so it drops
 *   straight into the tool registry — no hardcoded HR functions.
 * - Route every execute() call through callTool() and return text to the LLM.
 * - Shut down cleanly (close the client, which kills the child process).
 *
 * This whole file is the "glue". Nothing here knows what the HR tools *do* —
 * it just forwards names and arguments. Add a tool to the server and it shows
 * up in Steve automatically.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve the command used to launch the HR server as a child process. */
function serverLaunchCommand(): { command: string; args: string[] } {
  // Detect whether we're running compiled JS or TypeScript source by our own
  // module's extension. When running via tsx (pnpm start) this file is .ts and
  // we launch the .ts server through tsx; when running compiled output it's
  // .js and we launch the .js server directly with node.
  //
  // The HR server lives in a sibling top-level folder (hr-server/). Relative to
  // this file the path is the same in both layouts:
  //   dev:      src/mcp/hr-mcp-client.ts  → ../../hr-server/hr-server.ts
  //   compiled: dist/src/mcp/...js        → ../../hr-server/hr-server.js
  const isCompiled = import.meta.url.endsWith('.js');
  const ext = isCompiled ? '.js' : '.ts';
  const serverPath = resolve(here, '..', '..', 'hr-server', `hr-server${ext}`);

  if (isCompiled) {
    return { command: process.execPath, args: [serverPath] };
  }

  // Invoke tsx through node directly — cross-platform, and avoids the
  // "npx is not a valid Win32 application" class of spawn problems.
  const tsxCli = resolve(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return { command: process.execPath, args: [tsxCli, serverPath] };
}

export interface HrMcpConnection {
  /** Tools discovered on the server, wrapped for the agent's registry. */
  tools: Tool[];
  /** Close the client and terminate the child server process. */
  close: () => Promise<void>;
}

/**
 * Connect to the HR MCP server and return its tools (already mapped into the
 * agent's `Tool` interface) plus a close() handle.
 *
 * @param dbPath Optional SQLite path forwarded to the child via HR_DB_PATH.
 *               Used by tests to point at a temp database.
 */
export async function connectHrMcp(dbPath?: string): Promise<HrMcpConnection> {
  const client = new Client({ name: 'steve-code-reviewer', version: '1.0.0' });

  const { command, args } = serverLaunchCommand();

  const transport = new StdioClientTransport({
    command,
    args,
    // Inherit the environment so the child can read its own config, and
    // optionally override the DB path (for tests / isolated demo data).
    env: {
      ...stringEnv(process.env),
      ...(dbPath ? { HR_DB_PATH: dbPath } : {}),
    },
    // Forward the server's stderr (its banner + logs) to ours so the user sees
    // "HR server running". stdout stays reserved for the JSON-RPC protocol.
    stderr: 'inherit',
  });

  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const tools: Tool[] = mcpTools.map((mcpTool) => ({
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    parameters: mcpInputSchemaToGemini(mcpTool.inputSchema),
    isHrAction: true,
    execute: async (toolArgs: Record<string, unknown>) => {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: toolArgs,
      });
      return renderToolResult(result);
    },
  }));

  return {
    tools,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Flatten a MCP tool result into a plain string for the LLM.
 *
 * MCP returns a list of typed content blocks and an optional isError flag.
 * Validation failures and thrown handlers come back as isError results (not
 * exceptions), so we surface them as readable text the model can react to.
 */
function renderToolResult(result: {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}): string {
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const body = text || '(no content returned)';
  return result.isError ? `Error: ${body}` : body;
}

/** Keep only string-valued env vars (StdioClientTransport expects Record<string,string>). */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
