# AI Code Review Agent — From Scratch

An educational project showing how to build an AI agent **without any agent frameworks** (no LangChain, CrewAI, OpenAI Agents SDK, etc.).

Built with Node.js, TypeScript, and the Gemini API.

## What is this?

A working AI agent that reviews your git diff. It:

1. Reads uncommitted changes from your repo (`git diff HEAD`)
2. Decides if it needs more context (reads additional files)
3. Produces a structured code review with file/line references

The agent is a **loop** — the LLM calls tools, gets results, and repeats until it has enough information to write a review. That's it. No magic, no framework, ~80 lines of core logic.

## Meet Steve

Steve is the reviewer persona. He's a sarcastic senior engineer who's seen too many production incidents. He talks to himself while working and isn't afraid to be blunt about your code.

## Project structure

```
src/
├── index.ts              ← entry point
├── agent.ts              ← the agent loop (core of the project)
├── llm-provider.ts       ← LLM interface (swap Gemini for OpenAI/Anthropic/Ollama)
├── gemini-provider.ts    ← Gemini implementation with retry & thoughtSignature
├── tools.ts              ← tool registry
├── prompts.ts            ← Steve's system prompt
└── tools/
    ├── get-diff.ts       ← tool: run git diff
    └── get-file.ts       ← tool: read a file from the repo

tests/                    ← unit tests (vitest, no API calls needed)
```

## How the agent loop works

```
User: "Review the current git diff"
         │
         ▼
┌─── LOOP (max 10 steps) ────────┐
│                                 │
│  1. Send history to LLM        │
│         │                       │
│         ▼                       │
│  2. LLM responds:              │
│     • text → DONE, return it   │
│     • toolCalls → continue     │
│         │                       │
│         ▼                       │
│  3. Execute tools               │
│  4. Append results to history   │
│  5. Go to step 1               │
│                                 │
└─────────────────────────────────┘
```

## Setup

```bash
# Install dependencies
pnpm install

# Add your Gemini API key
cp .env.example .env
# Edit .env and paste your key
```

Get a key at [Google AI Studio](https://aistudio.google.com/apikey).

## Usage

```bash
# Make some changes to the code, then:
pnpm start
```

The agent will review your uncommitted git changes.

## Other commands

```bash
pnpm test       # run tests (no API key needed)
pnpm build      # compile TypeScript
pnpm lint       # run ESLint
pnpm format     # run Prettier
```

## Key concepts demonstrated

- **Agent loop** — the model decides when to use tools and when to stop
- **Function calling** — structured tool invocation via Gemini API (no text parsing)
- **Multi-turn conversation** — history grows with each tool call/result
- **Thought signatures** — Gemini 3 requires echoing back `thoughtSignature` in conversation history
- **Provider abstraction** — swap LLM providers without changing agent logic
- **Tool registry** — simple interface, easy to extend with new tools

## Tech stack

- Node.js + TypeScript
- `@google/genai` (Gemini SDK)
- `vitest` for testing
- ESLint + Prettier
- pnpm

## License

MIT
