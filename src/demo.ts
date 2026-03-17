import { GoogleGenAI } from "@google/genai";
import { buildIndex, formatIndexForPrompt, countNaiveTokens } from "./repoIndex";
import * as path from "path";
import * as fs from "fs";
import "dotenv/config";
console.log("=== STARTING DEMO ===");

const TARGET_DIR = process.argv[2] || ".";
const QUESTION = process.argv[3] || "What are the main exported functions and interfaces?";

const estimateTokens = (text: string): number => Math.round(text.length / 4);

console.log("Target:", TARGET_DIR);
console.log("Question:", QUESTION);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("ERROR: GEMINI_API_KEY not set");
  process.exit(1);
}
console.log("API key: found");

async function main() {
  console.log("\n[ 1/4 ] Building typed semantic skeleton...");

  let index: ReturnType<typeof buildIndex>;
  try {
    index = buildIndex(TARGET_DIR);
  } catch (e: unknown) {
    console.error("ERROR building index:", e);
    process.exit(1);
  }

  const filesIndexed = Object.keys(index).length;
  console.log("       Files indexed:", filesIndexed);

  const skeletonText = formatIndexForPrompt(index);
  const skeletonTokens = estimateTokens(skeletonText);
  const naiveTokens = countNaiveTokens(TARGET_DIR);

  console.log("       Skeleton tokens:    ~" + skeletonTokens.toLocaleString());
  console.log("       Naive load-all cost:~" + naiveTokens.toLocaleString());

  if (filesIndexed === 0) {
    console.log("\nWARNING: No exported TypeScript files found in", TARGET_DIR);
    console.log("The skeleton is empty. Gemini will have nothing to reason over.");
    console.log("Try pointing at a directory with .ts files that have exports.");
    return;
  }

  const ai = new GoogleGenAI({ apiKey });

  const tools = [{
    name: "read_file",
    description: "Read a specific file from the repository on demand.",
    parameters: {
      type: "object" as const,
      properties: {
        relativePath: { type: "string" as const, description: "Relative path to the file" },
        symbolsOnly: { type: "boolean" as const, description: "Return only exports" },
      },
      required: ["relativePath"],
    },
  }];

  const systemPrompt = `You are a code repository analyst.
You have a typed semantic skeleton of the repository below.
Answer the question using the skeleton. Only call read_file if you need implementation details.
Never call read_file more than 3 times.

Repository skeleton:
${skeletonText}`;

  console.log("\n[ 2/4 ] Simulating agentic loop (mock mode — no API quota needed)...");
  console.log("       NOTE: Live API call skipped to avoid free-tier quota.");
  console.log("       The skeleton above is what would be sent to Gemini.");
  console.log("       In a live run the agent would call read_file() on demand.");

  // Simulate the agent reading 2 files on demand
  console.log("\n[ 3/4 ] Simulating lazy file reads...");

  let fileTokens = 0;
  let filesRead = 0;
  const filePaths = Object.keys(index).slice(0, 2);
  for (const filePath of filePaths) {
    const fullPath = path.join(TARGET_DIR, filePath);
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const lines = raw.split("\n").slice(0, 300);
      const content = lines.join("\n");
      const tokenEstimate = estimateTokens(content);
      filesRead++;
      fileTokens += tokenEstimate;
      console.log(`       -> read: ${filePath} (~${tokenEstimate} tokens, capped at 300 lines)`);
      console.log(`          ${lines[0]?.slice(0, 80)}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`       -> skip: ${filePath} (${message})`);
    }
  }

  const totalTokens = skeletonTokens + fileTokens;

  console.log("\n========================================");
  console.log("  MOCK AGENT ANSWER");
  console.log("========================================");
  console.log(`The codebase exports the following (from skeleton analysis):`);
  console.log(skeletonText);

  console.log("\n========================================");
  console.log("  TOKEN SUMMARY");
  console.log("========================================");
  console.log("Files indexed (skeleton)  :", filesIndexed);
  console.log("Files read on demand      :", filesRead);
  console.log("Skeleton tokens           : ~" + skeletonTokens.toLocaleString());
  console.log("File read tokens          : ~" + fileTokens.toLocaleString());
  console.log("TOTAL session tokens      : ~" + totalTokens.toLocaleString());
  console.log("Naive load-all cost       : ~" + naiveTokens.toLocaleString());
  console.log("Reduction demonstrated    : " + naiveTokens.toLocaleString() + " -> " + totalTokens.toLocaleString() + " tokens");

  // Save benchmark
  const bench = {
    timestamp: new Date().toISOString(),
    targetDir: path.resolve(TARGET_DIR),
    filesIndexed,
    skeletonTokens,
    naiveTokens,
    totalSessionTokens: totalTokens,
    filesReadOnDemand: filesRead,
    fileTokens,
    question: QUESTION,
    mode: "mock — skeleton + lazy reader demonstrated without live API call",
  };
  let existing: typeof bench[] = [];
  try {
    existing = JSON.parse(fs.readFileSync("benchmark-results.json", "utf-8"));
  } catch {
    // File may not exist yet; start a new benchmark log.
  }
  existing.push(bench);
  fs.writeFileSync("benchmark-results.json", JSON.stringify(existing, null, 2));
  console.log("\nBenchmark saved to benchmark-results.json");
}

main().catch((e: unknown) => {
  console.error("UNHANDLED ERROR:", e);
  process.exit(1);
});