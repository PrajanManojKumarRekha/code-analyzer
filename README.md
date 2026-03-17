# Rocket.Chat Code Analyzer

**GSoC 2026 — Agentic Inference Context Reduction Mechanics**

Applicant: Prajan Manoj Kumar Rekha | Mentor: William Liu | Org: Rocket.Chat

---

## The Problem

Running gemini-cli against the Rocket.Chat monorepo costs ~1,883,381 tokens just to
load the packages/core/src directory. That blows the free-tier Gemini quota before
answering a single question. This prototype demonstrates the fix.

## The Solution

Three-layer context reduction:

1. **Typed Semantic Skeleton** (`src/repoIndex.ts`) — scans the repo with ts-morph,
   extracts only exported function/interface/type signatures. ~14k tokens instead of ~1.8M.

2. **Lazy File Reader** (`src/lazyFileReader.ts`) — agent fetches specific files on
   demand, max 300 lines, only when it actually needs implementation detail.

3. **Query Intent Classifier** (`src/queryClassifier.ts`) — maps the user's question
   to a Rocket.Chat domain (mobile / front-end / auth / etc.) and eliminates irrelevant
   package subtrees before the skeleton is even built. *(Phase 2)*

## Prototype Results (real measured numbers)

| Directory | Naive cost | Sparse index | Files read | Total tokens |
|---|---|---|---|---|
| tools/ (80 files) | ~309,377 tok | ~1,585 tok | 3 / 80 | ~7,770 tok |
| core/src/ (682 files) | ~1,883,381 tok | ~13,927 tok | — | ~13,927 tok |

## Quick Start
```bash
npm install
$env:GEMINI_API_KEY = "your-key-here"      # PowerShell
npx tsx src/demo.ts ./src "What are the main exports in this codebase?"
```

## Repo Structure
```
src/
  repoIndex.ts          ← typed semantic skeleton builder (ts-morph)
  lazyFileReader.ts     ← on-demand file fetcher (300-line cap)
  demo.ts               ← end-to-end agentic loop demo
  queryClassifier.ts    ← domain-scope intent classifier (coming Phase 2)
gemini-extension/
  tools/index.ts        ← shows how tools register in gemini-cli
tests/
  repoIndex.test.ts     ← unit tests
benchmark-results.json  ← real measured token numbers
```

## Architecture
```
User question
     ↓
queryClassifier.ts   → eliminates irrelevant RC domains
     ↓
repoIndex.ts         → builds typed skeleton (~14k tokens)
     ↓
Gemini agent         → reasons over skeleton
     ↓ (only if needed)
lazyFileReader.ts    → fetches specific file on demand
     ↓
Answer produced
```