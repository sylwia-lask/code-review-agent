import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
} from '@google/genai';
import type { LlmProvider, LlmResponse } from './llm-provider.js';

/**
 * LLM provider implementation for Google Gemini.
 *
 * Handles:
 * - Multi-turn conversations with tool (function) calling
 * - Preserving thoughtSignature for Gemini 3 models
 * - Automatic retry on 503 (service unavailable) errors
 */
export class GeminiProvider implements LlmProvider {
  private ai: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async chat(
    messages: Content[],
    tools: FunctionDeclaration[],
    systemPrompt: string,
  ): Promise<LlmResponse> {
    return this.callWithRetry(messages, tools, systemPrompt);
  }

  private async callWithRetry(
    messages: Content[],
    tools: FunctionDeclaration[],
    systemPrompt: string,
    maxRetries = 3,
  ): Promise<LlmResponse> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: this.model,
          contents: messages,
          config: {
            systemInstruction: systemPrompt,
            tools: [{ functionDeclarations: tools }],
          },
        });

        return this.parseResponse(response);
      } catch (error: unknown) {
        const isUnavailable =
          error instanceof Error &&
          'status' in error &&
          (error as { status: number }).status === 503;

        if (isUnavailable && attempt < maxRetries) {
          const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
          console.log(
            `⏳ Model unavailable (503). Retrying in ${delayMs / 1000}s... (attempt ${attempt}/${maxRetries})`,
          );
          await this.sleep(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw new Error('Unexpected: retry loop exited without result');
  }

  /**
   * Parse the Gemini response into our LlmResponse format.
   *
   * Key: we preserve rawParts so the agent loop can store them in history
   * exactly as-is. This is critical for Gemini 3 which requires
   * thoughtSignature to be echoed back in subsequent requests.
   */
  private parseResponse(response: GenerateContentResponse): LlmResponse {
    const functionCalls = response.functionCalls;
    const rawParts = response.candidates?.[0]?.content?.parts ?? [];

    if (functionCalls && functionCalls.length > 0) {
      // Extract any text the model said alongside tool calls (inner monologue)
      const thinkingParts = rawParts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text);
      const thinking = thinkingParts.join(' ').trim() || undefined;

      return {
        toolCalls: functionCalls.map((fc) => ({
          id: fc.id,
          name: fc.name ?? '',
          args: fc.args ?? {},
        })),
        rawParts,
        thinking,
      };
    }

    return { text: response.text ?? '', rawParts };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
