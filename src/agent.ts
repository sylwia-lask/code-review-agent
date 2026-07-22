import {
  createPartFromFunctionResponse,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';
import type { LlmProvider, ToolCall } from './llm-provider.js';
import { executeTool, toFunctionDeclarations, type Tool } from './tools.js';
import { colors, printStep } from './colors.js';

/**
 * Minimal agent loop.
 *
 * How it works:
 * 1. Send the user message + tool declarations to the LLM
 * 2. If the LLM returns tool calls → execute them, send results back
 * 3. Repeat until the LLM returns a final text response
 * 4. Safety limit: max N iterations to prevent infinite loops
 *
 * Important: We store the model's raw parts in history (not reconstructed ones)
 * because Gemini 3 requires thoughtSignature to be echoed back exactly.
 */
export async function runAgent(options: {
  llm: LlmProvider;
  tools: Tool[];
  systemPrompt: string;
  userMessage: string;
  maxIterations?: number;
}): Promise<string> {
  const { llm, tools, systemPrompt, userMessage, maxIterations = 10 } = options;

  const declarations: FunctionDeclaration[] = toFunctionDeclarations(tools);

  // Conversation history — starts with the user's request
  const messages: Content[] = [
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  for (let step = 1; step <= maxIterations; step++) {
    const response = await llm.chat(messages, declarations, systemPrompt);

    // --- Final text response → we're done ---
    if (response.text) {
      return response.text;
    }

    // --- Tool calls → execute and loop ---
    if (response.toolCalls) {
      // Print Steve's inner monologue if the model said something
      if (response.thinking) {
        console.log(colors.dim(`\n  💭 ${response.thinking}\n`));
      }

      // Add the model's response to history — using rawParts to preserve
      // thoughtSignature (required by Gemini 3 for function calling)
      const modelParts: Part[] =
        response.rawParts ??
        response.toolCalls.map((tc) => ({
          functionCall: { id: tc.id, name: tc.name, args: tc.args },
        }));

      messages.push({ role: 'model', parts: modelParts });

      // Execute each tool and log the step
      const resultParts = await executeToolCalls(tools, response.toolCalls, step);

      // Add tool results to history
      messages.push({ role: 'user', parts: resultParts });
    }
  }

  return 'Error: agent reached maximum iteration limit without producing a final response.';
}

/**
 * Execute tool calls and return function response parts.
 */
async function executeToolCalls(tools: Tool[], toolCalls: ToolCall[], step: number) {
  const parts = [];

  for (const tc of toolCalls) {
    printStep(step, tc.name, tc.args);

    const result = await executeTool(tools, tc.name, tc.args);
    parts.push(
      createPartFromFunctionResponse(tc.id ?? '', tc.name, { result }),
    );
  }

  return parts;
}
