import { describe, it, expect } from 'vitest';
import type { Content, FunctionDeclaration } from '@google/genai';
import type { LlmProvider, LlmResponse } from '../src/llm-provider.js';
import { runAgent } from '../src/agent.js';
import { getDiffTool } from '../src/tools/get-diff.js';
import { getFileTool } from '../src/tools/get-file.js';

/**
 * A mock LLM provider that simulates a 3-step agent interaction:
 * 1. First call → model asks for the diff (tool call: getDiff)
 * 2. Second call → model asks for a file (tool call: getFile)
 * 3. Third call → model produces the final review (text)
 */
function createMockLlm(): LlmProvider {
  let callCount = 0;

  return {
    async chat(
      _messages: Content[],
      _tools: FunctionDeclaration[],
      _systemPrompt: string,
    ): Promise<LlmResponse> {
      callCount++;

      switch (callCount) {
        case 1:
          // Step 1: model calls getDiff
          return {
            toolCalls: [
              { id: 'call-1', name: 'getDiff', args: {} },
            ],
          };

        case 2:
          // Step 2: model calls getFile to see auth.ts
          return {
            toolCalls: [
              { id: 'call-2', name: 'getFile', args: { path: 'src/auth.ts' } },
            ],
          };

        case 3:
          // Step 3: model produces final review
          return {
            text: '### Summary\nRemoved role verification from verifyToken.\n\n### Recommendation\n**REQUEST CHANGES**',
          };

        default:
          return { text: 'Unexpected call' };
      }
    },
  };
}

describe('Agent loop', () => {
  it('executes tools and produces a final review', async () => {
    const mockLlm = createMockLlm();

    const result = await runAgent({
      llm: mockLlm,
      tools: [getDiffTool, getFileTool],
      systemPrompt: 'You are a code reviewer.',
      userMessage: 'Review the code changes.',
    });

    expect(result).toContain('Summary');
    expect(result).toContain('REQUEST CHANGES');
  });

  it('respects maxIterations limit', async () => {
    // LLM that always returns tool calls, never a final answer
    const infiniteLlm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        return {
          toolCalls: [{ id: 'x', name: 'getDiff', args: {} }],
        };
      },
    };

    const result = await runAgent({
      llm: infiniteLlm,
      tools: [getDiffTool],
      systemPrompt: 'test',
      userMessage: 'test',
      maxIterations: 3,
    });

    expect(result).toContain('maximum iteration limit');
  });
});
