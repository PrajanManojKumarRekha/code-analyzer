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

The project now also includes a standard Gemini CLI extension manifest at the repository root, so the repo can be linked directly as an extension during development.

## Project Layout

```text
src/
     repoIndex.ts
     LazyFileReader.ts
     demo.ts
gemini-extension.json
GEMINI.md
gemini-extension/
     mcp/mcp-server.example.json
     tools/index.ts
tests/
     repoIndex.test.ts
     mcpLazyServer.test.ts
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

Build the project (required for extension runtime):

```bash
npm run build
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
     - `index_cache_stats` to inspect index/read cache status
     - `index_cache_invalidate` to clear stale cache state

- `gemini-extension/mcp/mcp-server.example.json`
     Example MCP server registration file for gemini-cli style configurations.

### Run the MCP server

```bash
npm run mcp:server
```

If you typed `npm runmcp:server`, that command will fail. Use `npm run mcp:server` with a space after `run`.

### Integrate with gemini-cli (standard extension flow)

1. Build the extension once:

```bash
npm run build
```

2. Link this repository as a Gemini extension:

```bash
gemini extensions link .
```

3. Restart gemini-cli.
4. Verify the extension is active:

```bash
gemini extensions list
```

5. Ask gemini-cli to use MCP tools with an instruction like:

```text
Use MCP tools for code analysis.
Call repo_index first for targetDir="<ABSOLUTE_PATH_TO_TARGET_REPO_SUBDIR>".
Then call read_file only when implementation details are needed.
```

### How to call Gemini from terminal

1. Start Gemini CLI:

```bash
gemini
```

2. In the interactive prompt, ask a scoped question and force tool usage:

```text
How does message sending work in Rocket.Chat?
Use MCP tools.
Call repo_index first with targetDir="<ABSOLUTE_PATH_TO_TARGET_REPO_SUBDIR>".
Then call read_file only for relevant files.
```

3. Confirm the tool calls appear in output (`repo_index`, then `read_file`).

6. For deep architecture questions such as message flow, auth flow, permissions, and E2E encryption, keep the same pattern:
      - `repo_index` once at the beginning
      - `read_file` only for specific files and sections

The `gemini-extension.json` manifest uses `${extensionPath}` so it runs cross-platform without hardcoded absolute paths.

### Full walkthrough on Windows

1. Open PowerShell in this repo:

```powershell
cd "<ABSOLUTE_PATH_TO_CODE_ANALYZER>"
```

2. Install dependencies once:

```powershell
npm install
```

3. Build before starting MCP server:

```powershell
npm run build
```

4. Start MCP server (correct command):

```powershell
npm run mcp:server
```

5. If you typed `npm runmcp:server`, it fails because `run` and script name must be separate.
6. For extension-based integration, run `gemini extensions link .` once and restart gemini-cli.
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

### Expected index cache behavior

- First `repo_index` call on a target directory: cache miss (index build).
- Repeated `repo_index` call in the same process: memory cache hit.
- Repeated `repo_index` call after restart with no relevant changes: disk cache hit.
- Any indexable file change: cache invalidates and rebuilds automatically.
- Use `forceRefresh=true` in `repo_index` to bypass cache manually.
- Use `index_cache_invalidate` to clear index cache and optionally clear `read_file` cache.

Cache metadata is returned in the `repo_index` response as:

- `cache.enabled`
- `cache.hit`
- `cache.layer`
- `cache.cacheFile`
- `cache.fingerprint`

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

## Working Example: Message Sending Analysis in Rocket.Chat

This project was validated against the Rocket.Chat codebase to trace how messages are sent through the system. The analysis demonstrates both the skeletal index approach and live MCP tool-calling.

### Message Sending Flow (Traced via repo_index + read_file)

The MCP server successfully extracted and analyzed the complete message pipeline:

1. **Entry Point (Meteor Method)**: The client calls the `sendMessage` Meteor method, which performs initial checks, enforces rate limits, and triggers `executeSendMessage`.

2. **Validation & Preparation (executeSendMessage)**: This step validates the message size, ensures the room exists, checks timestamps, and confirms the sender's identity. It also verifies if the user has permission to send messages in the specific room.

3. **Core Logic (sendMessage Function)**:
   - **Apps-Engine Hooks**: Triggers `IPreMessageSentPrevent`, `IPreMessageSentExtend`, and `IPreMessageSentModify` events.
   - **beforeSave Hooks**: Executes various filters (bad words, markdown, mentions, etc.) through the `Message.beforeSave` service call.
   - **Persistence**: The message is inserted into the Messages collection.
   - **Post-Persistence Apps-Engine**: Triggers `IPostMessageSent` or `IPostSystemMessageSent`.

4. **Post-Save Actions (afterSaveMessage)**:
   - **Callbacks**: Runs the `afterSaveMessage` callback, which includes `notifyUsersOnMessage`.
   - **Notifications & Updates**: Updates room activity trackers, adjusts user subscription unread counts/alerts, and broadcasts changes to clients via DDP (e.g., `notifyOnRoomChangedById`).
   - **Service-Level Post-Save**: `Message.afterSave` handles additional asynchronous tasks like OEmbed link parsing.

### MCP Server Status

The MCP server is **running and successfully integrated with gemini-cli**:

```
Configured MCP servers:
- rocketChatLazyIndex - Ready (2 tools)
  Tools:
    - mcp_rocketChatLazyIndex_read_file
    - mcp_rocketChatLazyIndex_repo_index
```

### Live Performance Metrics

Session metrics from querying "How does message sending work in Rocket.Chat?":

- **Session ID**: f1718aad-c001-4b0f-9bbd-27b662c82aa0
- **Tool Calls**: 10 (9 successful, 1 duplicate)
- **Success Rate**: 90.0%
- **User Confirmation**: 100.0% (9 reviewed)

**Wall Time**: 2m 42s  
**Agent Active**: 47.7s

- **API Time**: 24.0s (50.2%)
- **Tool Time**: 23.7s (49.8%)

**Token Efficiency**:
- **gemini-2.5-flash-lite**: 1 request → 1,087 input tokens + 86 output tokens
- **gemini-3-flash-preview**: 11 requests → 81,037 input tokens (207,415 from cache) + 1,412 output tokens

**Savings Highlight**: 207,415 (71.6%) of input tokens were served from cache, directly demonstrating the lazy-loading efficiency of the MCP approach.

## Development Commands

```bash
npm run demo
npm run mcp:server
npm run mcp:server:dev
npm test
npm run build
```

## Priorities and Next Steps

1. Replace the mock loop in `src/demo.ts` with a live tool-calling flow so the model can decide when to call `read_file`.
2. Add query intent routing (planned classifier layer) to scope indexing by domain before parsing, reducing initial index size.
3. Improve index fidelity with richer class details (constructors, overloads, visibility filters) while preserving compact output.
4. Expand tests for `src/LazyFileReader.ts`, especially path boundary checks, symbols-only output, and line-range edge cases.
5. Add optional TTL/size limits and cleanup for `.cache/repo-index` in long-running environments.
6. Document a release checklist for publishing this extension with versioned GitHub releases.