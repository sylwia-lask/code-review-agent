import type { Content, FunctionDeclaration, Part } from '@google/genai';

// --- Types for the agent loop ---

/**
 * A tool call requested by the model.
 */
export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * What the model returned: either a text response or tool calls to execute.
 * Includes raw parts so we can preserve thoughtSignature in history.
 */
export interface LlmResponse {
  text?: string;
  toolCalls?: ToolCall[];
  /** Raw model parts — must be stored in history as-is to preserve thoughtSignature */
  rawParts?: Part[];
  /** Any text the model said alongside tool calls (inner monologue / thinking out loud) */
  thinking?: string;
}

/**
 * A simple interface for any LLM provider.
 *
 * The application talks only through this interface,
 * so swapping Gemini for OpenAI/Anthropic/Ollama later
 * means just adding a new implementation — no changes to app logic.
 */
export interface LlmProvider {
  /**
   * Send a conversation (with optional tool declarations) to the model.
   * Returns either a text response or tool calls to execute.
   */
  chat(
    messages: Content[],
    tools: FunctionDeclaration[],
    systemPrompt: string,
  ): Promise<LlmResponse>;
}
