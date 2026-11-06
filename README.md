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
├── prompts.ts            ← Steve's system prompt (+ optional HR addendum)
├── colors.ts             ← terminal output helpers
├── tools/
│   ├── get-diff.ts       ← tool: run git diff
│   ├── get-file.ts       ← tool: read a file from the repo
│   └── list-files.ts     ← tool: list a directory
└── hr/                   ← Steve's HR Department (MCP bolt-on)
    ├── hr-db.ts          ← SQLite persistence (no AI, no MCP)
    ├── hr-server.ts      ← MCP server: 4 HR tools over stdio
    ├── hr-mcp-client.ts  ← MCP client: discovers + wraps tools for the agent
    ├── schema-convert.ts ← JSON Schema → Gemini parameter schema
    └── cli.ts            ← inspect / reset the HR database

tests/                    ← unit + integration tests (vitest, no API key needed)
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

# Steve's HR Department (MCP) — see the section below
pnpm hr:show    # print stored HR records as tables
pnpm hr:reset   # wipe + re-seed fictional demo data
pnpm hr:server  # run the HR MCP server standalone (for MCP Inspector)
```

## Steve's HR Department (MCP)

An optional, entirely fictional "HR department" built as a local **Model Context
Protocol (MCP)** server. It shows how little it takes to add MCP to an existing
agent: the server exposes tools, and Steve's agent loop picks them up through
the *same* `Tool` interface it already uses for `getDiff`/`getFile`. No agent
rewrite, no hardcoded HR functions.

> All HR records are made-up jokes for a demo. They are not real employment
> judgments. Steve roasts code, not people.

### How it fits together

```
┌─────────────────────────┐        stdio (JSON-RPC)        ┌──────────────────────────┐
│  Steve (MCP client)      │  ───────────────────────────▶ │  HR server (MCP server)   │
│  src/hr/hr-mcp-client.ts │                                │  src/hr/hr-server.ts      │
│                          │  listTools()  →  4 tools       │   • get_employee_record   │
│  wraps each MCP tool as  │  callTool()   →  text result   │   • file_complaint        │
│  a normal agent Tool     │ ◀───────────────────────────  │   • nominate_for_promotion│
└─────────────────────────┘                                │   • get_hr_stats          │
                                                            └────────────┬──────────────┘
                                                                         │
                                                              SQLite (.hr-data/hr.db)
```

- The client **spawns the server as a child process** over stdio and owns its
  lifetime — closing the client terminates the server.
- Tools are **discovered dynamically** with `listTools()`; their JSON Schema is
  converted to Gemini's parameter format and dropped into the tool registry.
- Every tool call is routed through `callTool()` and the text result is handed
  back to the LLM — exactly like a built-in tool.
- The LLM decides *whether* an HR action is appropriate. The server only stores
  and validates data (no AI lives in the server).

### The four tools

| Tool | What it does |
| --- | --- |
| `get_employee_record(developer)` | Read a developer's complaints and promotions |
| `file_complaint(developer, reason, severity)` | Store a complaint (`minor` → `legendary`) |
| `nominate_for_promotion(developer, reason)` | Record a positive achievement |
| `get_hr_stats()` | Department-wide statistics |

### Enable it

```bash
# In .env
MCP_ENABLED=true
PR_AUTHOR=Dusty McLegacy   # optional — lets Steve read/write the right record
```

Then run the agent as usual:

```bash
pnpm start
```

When enabled, Steve connects to the HR server on startup, lists the tools it
found, and every HR action it takes is highlighted in the output (`🧑‍💼 HR → …`).
When `MCP_ENABLED` is unset or `false`, Steve does plain code review — the MCP
code path is never touched.

### Sample scenario that triggers an HR action

A ready-made diff lives at `fixtures/sample.diff`. It removes a role-change
check from `verifyToken` — a real security regression. To reproduce a complaint:

```bash
# 1. Point Steve at a demo author and enable HR
#    (.env)  MCP_ENABLED=true   PR_AUTHOR=Dusty McLegacy

# 2. Introduce the risky change into your working tree, e.g. apply the fixture:
git apply fixtures/sample.diff   # or make a similar change by hand

# 3. Run Steve
pnpm start
```

Steve reads the diff, sees the dropped authorization check, and — because the
code is genuinely risky — files a complaint against the PR author before
delivering a **REQUEST CHANGES** verdict. Clean, well-tested changes may instead
earn a `nominate_for_promotion`. The decision is the model's, not ours.

### Inspect the stored records

The data is real SQLite you can read directly.

```bash
pnpm hr:show        # pretty tables of complaints + promotions
```

Or open the file with any SQLite tool:

```bash
sqlite3 .hr-data/hr.db "SELECT * FROM complaints;"
```

### Reset the demo data

Explicitly wipe everything and re-seed reproducible fictional records:

```bash
pnpm hr:reset
```

### Test the server independently with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is an
interactive UI for poking at an MCP server without a model. The Inspector
spawns the server command itself, so point it straight at our stdio entry:

```bash
# Browser UI (default) — requires Node 22.19+
npx @modelcontextprotocol/inspector npx tsx src/hr/hr-server.ts
```

It opens a browser UI where you can list the four tools, read their schemas, and
call them by hand — for example `file_complaint` with an invalid `severity` to
watch the validation error come back as an `isError` result.

Prefer the terminal or a scriptable check? The same package ships a TUI and a
CLI:

```bash
# Interactive terminal UI
npx @modelcontextprotocol/inspector --tui npx tsx src/hr/hr-server.ts

# One-shot: list the tools and exit (great for CI)
npx @modelcontextprotocol/inspector --cli npx tsx src/hr/hr-server.ts --method tools/list
```

The Inspector writes to its own database; it won't touch your `.hr-data/hr.db`
unless you actually call a write tool.

### Run the MCP tests

The integration test spawns the real server over stdio and exercises the full
client/server round trip (no API key needed):

```bash
pnpm test                               # everything
npx vitest run tests/hr-mcp.integration.test.ts   # just the MCP round trip
npx vitest run tests/hr-db.test.ts                # just SQLite persistence
```

## Key concepts demonstrated

- **Agent loop** — the model decides when to use tools and when to stop
- **Function calling** — structured tool invocation via Gemini API (no text parsing)
- **Multi-turn conversation** — history grows with each tool call/result
- **Thought signatures** — Gemini 3 requires echoing back `thoughtSignature` in conversation history
- **Provider abstraction** — swap LLM providers without changing agent logic
- **Tool registry** — simple interface, easy to extend with new tools
- **MCP integration** — a local MCP server's tools discovered at runtime and
  mapped onto the existing tool registry, with no changes to the agent loop

## Tech stack

- Node.js + TypeScript
- `@google/genai` (Gemini SDK)
- `@modelcontextprotocol/server` + `@modelcontextprotocol/client` (MCP SDK v2)
- `better-sqlite3` (HR persistence) + `zod` (tool input validation)
- `vitest` for testing
- ESLint + Prettier
- pnpm

## License

MIT
