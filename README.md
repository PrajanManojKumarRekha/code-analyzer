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

## Development Commands

```bash
npm run demo
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