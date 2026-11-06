import 'dotenv/config';
import { GeminiProvider } from './gemini-provider.js';
import { runAgent } from './agent.js';
import { buildReviewerSystemPrompt } from './prompts.js';
import { getDiffTool } from './tools/get-diff.js';
import { getFileTool } from './tools/get-file.js';
import { listFilesTool } from './tools/list-files.js';
import { connectHrMcp, type HrMcpConnection } from './mcp/hr-mcp-client.js';
import { colors, printHeader, printReview } from './colors.js';
import type { Tool } from './tools.js';

// --- Configuration ---
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';

// MCP is opt-in. When disabled, Steve behaves exactly as before — pure code review.
const hrEnabled = process.env.MCP_ENABLED === 'true';

// The PR author lets Steve look up / write the right HR record. Optional.
const prAuthor = process.env.PR_AUTHOR?.trim() || undefined;

if (!apiKey) {
  console.error('❌ Missing GEMINI_API_KEY in .env file');
  process.exit(1);
}

// --- Initialize LLM provider ---
const llm = new GeminiProvider(apiKey, model);

// --- Base tools (code review) ---
const baseTools: Tool[] = [getDiffTool, getFileTool, listFilesTool];

async function main() {
  printHeader('Code Review Agent');

  // --- Optionally connect to the HR MCP server ---
  let hr: HrMcpConnection | undefined;
  let tools = baseTools;

  if (hrEnabled) {
    try {
      hr = await connectHrMcp();
      tools = [...baseTools, ...hr.tools];
      console.log(
        colors.cyan(
          `  🧑‍💼 HR Department connected — ${hr.tools.length} MCP tools available: ` +
            hr.tools.map((t) => t.name).join(', '),
        ),
      );
      if (prAuthor) {
        console.log(colors.dim(`  PR author: ${prAuthor}`));
      }
    } catch (error) {
      // MCP is a bonus — if it fails to start, fall back to plain review.
      console.error(
        colors.yellow(
          `  ⚠️  Could not start HR MCP server (${(error as Error).message}). ` +
            'Continuing with code review only.',
        ),
      );
      hr = undefined;
      tools = baseTools;
    }
  }

  try {
    const systemPrompt = buildReviewerSystemPrompt({
      hrEnabled: hrEnabled && hr !== undefined,
      prAuthor,
    });

    const review = await runAgent({
      llm,
      tools,
      systemPrompt,
      userMessage: 'Please review the current git diff.',
    });

    printHeader('Review Complete');
    printReview(review);
  } finally {
    // Always close the MCP client, which terminates the child server process.
    if (hr) {
      await hr.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
