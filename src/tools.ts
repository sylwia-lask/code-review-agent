import type { FunctionDeclaration } from '@google/genai';

/**
 * A tool that the agent can use.
 *
 * Each tool has:
 * - a name (used by the model to call it)
 * - a description (helps the model decide when to use it)
 * - a parameters schema (tells the model what arguments to pass)
 * - an execute function (runs the tool and returns a result)
 */
export interface Tool {
  name: string;
  description: string;
  parameters: FunctionDeclaration['parameters'];
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Convert our tools into Gemini's FunctionDeclaration format.
 * This is the bridge between our simple tool format and the SDK.
 */
export function toFunctionDeclarations(tools: Tool[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Find a tool by name and execute it.
 * Returns the result as a string (to be sent back to the model).
 */
export async function executeTool(
  tools: Tool[],
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    return `Error: unknown tool "${name}"`;
  }

  return tool.execute(args);
}
