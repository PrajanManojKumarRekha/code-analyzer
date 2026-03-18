# Rocket.Chat Code Analyzer

This project is a prototype for reducing LLM context cost when analyzing large TypeScript repositories.

Instead of loading full source files up front, it builds a compact structural index of exports and reads implementation details only when needed.

## Why This Exists

Large monorepos can consume a massive number of tokens before an assistant answers a single question. This project demonstrates a practical workflow to keep that cost predictable:

1. Build a typed repository skeleton from exported symbols.
2. Let the agent reason over the skeleton first.
3. Read only the files and line ranges needed for deeper answers.

## Current Architecture

The codebase currently has three primary pieces:

- `src/repoIndex.ts`
     Walks a target directory, parses TypeScript with `ts-morph`, and extracts exported signatures for functions, classes, interfaces, type aliases, and enums.

- `src/LazyFileReader.ts`
     Reads file content on demand with controls for maximum lines, optional line ranges, and symbols-only mode. It also enforces a base directory boundary to prevent path traversal.

- `src/demo.ts`
     End-to-end demonstration script. It builds the skeleton, simulates selective file reads, and logs benchmark output to `benchmark-results.json`.

There is also a tool registration example in `gemini-extension/tools/index.ts` showing how these capabilities can be surfaced in a Gemini-compatible tool layer.

## Project Layout

```text
src/
     repoIndex.ts
     LazyFileReader.ts
     demo.ts
gemini-extension/
     tools/index.ts
tests/
     repoIndex.test.ts
benchmark-results.json
benchmark-results-mcp.json
```

## Setup

Requirements:

- Node.js 18+
- npm

Install dependencies:

```bash
npm install
```

Create local environment file:

```bash
copy .env.example .env
```

Then set your key in `.env`:

```env
GEMINI_API_KEY=your-key-here
```

PowerShell alternative (session-only):

```powershell
$env:GEMINI_API_KEY = "your-key-here"
```

## Method 1: Local Sparse Index + Lazy Reader

This method runs everything locally from this repository and is the baseline implementation.

## Usage

Run the demo against a target directory:

```bash
npx tsx src/demo.ts ./src "What are the main exports in this codebase?"
```

Arguments:

- Arg 1: target directory (default: `.`)
- Arg 2: question string (default: a generic exports question)

What the demo does:

1. Builds an index of exported symbols.
2. Estimates skeleton token cost vs naive full-read cost.
3. Simulates reading only selected files.
4. Appends a run record to `benchmark-results.json`.

## Method 2: MCP + Gemini CLI Lazy Loading

Option 2 moves repository reads to an MCP server so gemini-cli can call tools instead of loading large file sets directly into prompt context.

This is useful for questions like:

- How are messages sent in Rocket.Chat?
- How does user authentication work?
- How are permissions checked?
- What is the E2E encryption flow?

### What was added

- `src/mcpLazyServer.ts`
     MCP stdio server exposing two tools:
     - `repo_index` to return a typed skeleton for a target directory
     - `read_file` to lazily fetch only needed file content

- `gemini-extension/mcp/mcp-server.example.json`
     Example MCP server registration file for gemini-cli style configurations.

### Run the MCP server

```bash
npm run mcp:server
```

If you typed `npm runmcp:server`, that command will fail. Use `npm run mcp:server` with a space after `run`.

### Integrate with gemini-cli

1. Open `gemini-extension/mcp/mcp-server.example.json`.
2. Confirm the `cwd` points to your local `code-analyzer` path.
3. In your gemini-cli MCP configuration, add this server under `mcpServers`:

```json
{
     "mcpServers": {
          "rocketChatLazyIndex": {
               "command": "npm",
               "args": ["run", "mcp:server"],
               "cwd": "<ABSOLUTE_PATH_TO_CODE_ANALYZER>",
               "env": {}
          }
     }
}
```

4. Save config and restart gemini-cli.
5. If you are not sure where to put this config, use your gemini-cli MCP config location and merge the `mcpServers.rocketChatLazyIndex` block.
6. Ask gemini-cli to use MCP tools with an instruction like:

```text
Use MCP tools for code analysis.
Call repo_index first for targetDir="<ABSOLUTE_PATH_TO_TARGET_REPO_SUBDIR>".
Then call read_file only when implementation details are needed.
```

7. For deep architecture questions such as message flow, auth flow, permissions, and E2E encryption, keep the same pattern:
      - `repo_index` once at the beginning
      - `read_file` only for specific files and sections

### Full walkthrough on Windows

1. Open PowerShell in this repo:

```powershell
cd "<ABSOLUTE_PATH_TO_CODE_ANALYZER>"
```

2. Install dependencies once:

```powershell
npm install
```

3. Start MCP server (correct command):

```powershell
npm run mcp:server
```

4. If you typed `npm runmcp:server`, it fails because `run` and script name must be separate.
5. Register the server in gemini-cli using the JSON block above.
6. Restart gemini-cli so it reloads MCP servers.
7. Ask one of your target questions and explicitly request MCP tool usage:

```text
How are messages sent in Rocket.Chat?
Use MCP tools.
Call repo_index first for targetDir="<ABSOLUTE_PATH_TO_TARGET_REPO_SUBDIR>".
Then call read_file only for required files.
```

8. Verify in gemini-cli output that tool calls appear for `repo_index` and `read_file`.
9. Record MCP benchmark run separately:

```powershell
npx tsx src/demo.ts --mode mcp "<ABSOLUTE_PATH_TO_TARGET_REPO_SUBDIR>" "How are messages sent in Rocket.Chat?"
```

10. MCP mode appends results to `benchmark-results-mcp.json` and keeps `benchmark-results.json` unchanged.

### Verify MCP server is reachable

1. Start server in one terminal:

```bash
npm run mcp:server
```

2. In gemini-cli, run a prompt that explicitly requests tool usage.
3. You should see tool calls to `repo_index` and `read_file` instead of broad source dumps.

### Capture final MCP benchmark results

1. Run analysis with MCP enabled for your target question.
2. Use `npx tsx src/demo.ts --mode mcp <targetDir> "<question>"` to append a run to `benchmark-results-mcp.json`.
3. Keep `benchmark-results.json` as your local baseline and mock comparison.

Current MCP benchmark snapshot is included in `benchmark-results-mcp.json`.

## Current Results Summary

Method 1 (Local sparse index + lazy reader):

- `benchmark-results.json` contains local baseline runs.
- Example measured run: 309,357 naive tokens reduced to 14,252 total session tokens.

Method 2 (MCP + Gemini CLI lazy loading):

- `benchmark-results-mcp.json` contains MCP-specific runs.
- Current snapshot preserves the same measured token profile while moving retrieval to MCP tool calls.

### Why this reduces token cost

1. Skeleton first: the model gets compact exported signatures instead of full source files.
2. Lazy fetches: implementation is retrieved only when necessary.
3. Scoped reads: `symbolsOnly`, `lineRange`, and `maxLines` keep payloads bounded.

## Development Commands

```bash
npm run demo
npm run mcp:server
npm test
npm run build
```

## Priorities and Next Steps

1. Replace the mock loop in `src/demo.ts` with a live tool-calling flow so the model can decide when to call `read_file`.
2. Add query intent routing (planned classifier layer) to scope indexing by domain before parsing, reducing initial index size.
3. Improve index fidelity with richer class details (constructors, overloads, visibility filters) while preserving compact output.
4. Expand tests for `src/LazyFileReader.ts`, especially path boundary checks, symbols-only output, and line-range edge cases.
5. Add cache and invalidation for index generation to avoid re-parsing unchanged repositories.
6. Document an integration path from `gemini-extension/tools/index.ts` into a production CLI/plugin runtime.