import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { Tool } from '../tools.js';
import { mcpInputSchemaToGemini } from './schema-convert.js';

/**
 * MCP client that connects Steve to the HR Department server.
 *
 * It spawns the server as a child over stdio, discovers tools with listTools(),
 * wraps each one in the agent's existing `Tool` interface, and routes execute()
 * calls through callTool(). Nothing here knows what the HR tools *do* — add a
 * tool to the server and it shows up in Steve automatically.
 */

const here = dirname(fileURLToPath(import.meta.url));

function serverLaunchCommand(): { command: string; args: string[] } {
  // The server path is the same relative to this file in both layouts:
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
  const tsxCli = resolve(
    here,
    '..',
    '..',
    'node_modules',
    'tsx',
    'dist',
    'cli.mjs',
  );
  return { command: process.execPath, args: [tsxCli, serverPath] };
}

export interface HrMcpConnection {
  tools: Tool[];
  /** Close the client and terminate the child server process. */
  close: () => Promise<void>;
}

export interface ConnectHrMcpOptions {
  /**
   * Optional identity of the code actually under review. When set, client-side
   * calls to `file_complaint` verify the LLM's `snapshot_id` before forwarding
   * the call to the MCP server, rejecting invented or stale identifiers.
   *
   * - A function is evaluated on every call (Steve passes
   *   `getLastReviewedSnapshotId`, i.e. the `Reviewed Snapshot ID` emitted by
   *   the latest getDiff run). If it returns undefined, filing is blocked until
   *   getDiff has produced a snapshot.
   * - A `<head_short>:<diff_hash>` snapshot must match exactly.
   * - A plain commit SHA (for clients reviewing closed commits) also accepts
   *   any 7..40 hex prefix of it.
   */
  expectedSnapshotId?: string | (() => string | undefined);
}

const PLAIN_COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/**
 * Returns an error message if `provided` does not identify the expected
 * reviewed snapshot, or undefined when the call may proceed.
 */
export function checkSnapshotId(
  provided: unknown,
  expected: string | undefined,
): string | undefined {
  const exp = expected?.trim().toLowerCase();
  if (!exp) {
    return 'Error: no reviewed snapshot is available yet. Call getDiff first and use its exact "Reviewed Snapshot ID".';
  }
  const got = typeof provided === 'string' ? provided.trim().toLowerCase() : '';
  if (!got) {
    // Let the MCP server's schema validation report the missing field.
    return undefined;
  }
  const matches =
    got === exp ||
    (PLAIN_COMMIT_SHA.test(exp) &&
      PLAIN_COMMIT_SHA.test(got) &&
      (exp.startsWith(got) || got.startsWith(exp)));
  return matches
    ? undefined
    : `Error: snapshot_id "${got}" does not match the reviewed snapshot "${exp}". Use the exact "Reviewed Snapshot ID" reported by getDiff.`;
}

/**
 * Connect to the HR MCP server and return its tools, already mapped into the
 * agent's `Tool` interface, plus a close() handle.
 *
 * @param dbPath Optional SQLite path forwarded to the child via HR_DB_PATH
 *               (tests use it to point at a temp database).
 * @param options Optional client-side harness safeguards (such as `expectedSnapshotId`).
 */
export async function connectHrMcp(
  dbPath?: string,
  options?: ConnectHrMcpOptions,
): Promise<HrMcpConnection> {
  const client = new Client({ name: 'steve-code-reviewer', version: '1.0.0' });

  const { command, args } = serverLaunchCommand();

  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...stringEnv(process.env),
      ...(dbPath ? { HR_DB_PATH: dbPath } : {}),
    },
    stderr: 'inherit',
  });

  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const expected = options?.expectedSnapshotId;
  const resolveExpected = (): string | undefined =>
    typeof expected === 'function' ? expected() : expected;

  const tools: Tool[] = mcpTools.map((mcpTool) => ({
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    parameters: mcpInputSchemaToGemini(mcpTool.inputSchema),
    isHrAction: true,
    execute: async (toolArgs: Record<string, unknown>) => {
      if (mcpTool.name === 'file_complaint' && expected !== undefined) {
        const guardError = checkSnapshotId(
          toolArgs.snapshot_id,
          resolveExpected(),
        );
        if (guardError) return guardError;
      }

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
 * Flatten an MCP tool result into a plain string for the LLM. Validation
 * failures and thrown handlers arrive as isError results (not exceptions), so
 * we surface them as readable text the model can react to.
 */
function renderToolResult(result: {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}): string {
  const blocks = result.content ?? [];

  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  // Fall back to the raw content when an error carries no text block, so the
  // actual cause isn't hidden behind a generic "(no content returned)".
  const fallback =
    blocks.length > 0 ? JSON.stringify(blocks) : '(no content returned)';

  const body = text || fallback;
  return result.isError ? `Error: ${body}` : body;
}

/** StdioClientTransport expects Record<string,string>, so drop non-string env vars. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
