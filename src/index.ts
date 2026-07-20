import 'dotenv/config';
import { GeminiProvider } from './gemini-provider.js';
import { runAgent } from './agent.js';
import { REVIEWER_SYSTEM_PROMPT } from './prompts.js';
import { getDiffTool } from './tools/get-diff.js';
import { getFileTool } from './tools/get-file.js';

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
const tools = [getDiffTool, getFileTool];

// --- Run the agent ---
async function main() {
  console.log('🤖 Starting code review agent (Steve)...\n');

  const review = await runAgent({
    llm,
    tools,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    userMessage: 'Please review the latest code changes.',
  });

  console.log('--- CODE REVIEW ---\n');
  console.log(review);
}

main();
