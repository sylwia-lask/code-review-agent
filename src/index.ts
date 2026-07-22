import 'dotenv/config';
import { GeminiProvider } from './gemini-provider.js';
import { runAgent } from './agent.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts.js';
import { getDiffTool } from './tools/get-diff.js';
import { getFileTool } from './tools/get-file.js';
import { listFilesTool } from './tools/list-files.js';
import { printHeader, printReview } from './colors.js';

// --- Configuration ---
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

if (!apiKey) {
  console.error('❌ Missing GEMINI_API_KEY in .env file');
  process.exit(1);
}

// --- Initialize LLM provider ---
const llm = new GeminiProvider(apiKey, model);

// --- Register tools ---
const tools = [getDiffTool, getFileTool, listFilesTool];

// --- Run the agent ---
async function main() {
  printHeader('Code Review Agent');

  const review = await runAgent({
    llm,
    tools,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    userMessage: 'Please review the current git diff.',
  });

  printHeader('Review Complete');
  printReview(review);
}

main();
