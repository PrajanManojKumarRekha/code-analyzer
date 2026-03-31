"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const genai_1 = require("@google/genai");
const repoIndex_1 = require("./repoIndex");
const LazyFileReader_1 = require("./LazyFileReader");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
require("dotenv/config");
console.log("=== STARTING DEMO ===");
function parseCliArgs(args) {
    let mode = "mock";
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--mode") {
            const value = args[i + 1];
            if (value === "mock" || value === "mcp" || value === "live") {
                mode = value;
                i++;
                continue;
            }
        }
        positional.push(arg);
    }
    return {
        mode,
        targetDir: positional[0] || ".",
        question: positional[1] || "What are the main exported functions and interfaces?",
    };
}
const { mode: RUN_MODE, targetDir: TARGET_DIR, question: QUESTION } = parseCliArgs(process.argv.slice(2));
const estimateTokens = (text) => Math.round(text.length / 4);
console.log("Target:", TARGET_DIR);
console.log("Question:", QUESTION);
console.log("Mode:", RUN_MODE);
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("ERROR: GEMINI_API_KEY not set");
    process.exit(1);
}
console.log("API key: found");
async function main() {
    console.log("\n[ 1/4 ] Building typed semantic skeleton...");
    let indexResult;
    try {
        indexResult = (0, repoIndex_1.buildIndexWithCache)(TARGET_DIR, { useCache: true });
    }
    catch (e) {
        console.error("ERROR building index:", e);
        process.exit(1);
    }
    const index = indexResult.index;
    const cacheStatus = indexResult.cache;
    const filesIndexed = Object.keys(index).length;
    console.log("       Files indexed:", filesIndexed);
    if (cacheStatus.enabled) {
        console.log("       Index cache hit:", cacheStatus.hit ? "yes" : "no");
        if (cacheStatus.cacheFile) {
            console.log("       Cache file:", cacheStatus.cacheFile);
        }
    }
    const skeletonText = (0, repoIndex_1.formatIndexForPrompt)(index);
    const skeletonTokens = estimateTokens(skeletonText);
    const naiveTokens = (0, repoIndex_1.countNaiveTokens)(TARGET_DIR);
    console.log("       Skeleton tokens:    ~" + skeletonTokens.toLocaleString());
    console.log("       Naive load-all cost:~" + naiveTokens.toLocaleString());
    if (filesIndexed === 0) {
        console.log("\nWARNING: No exported TypeScript files found in", TARGET_DIR);
        console.log("The skeleton is empty. Gemini will have nothing to reason over.");
        console.log("Try pointing at a directory with .ts files that have exports.");
        return;
    }
    const ai = new genai_1.GoogleGenAI({ apiKey });
    const tools = [{
            name: "read_file",
            description: "Read a specific file from the repository on demand.",
            parameters: {
                type: "object",
                properties: {
                    relativePath: { type: "string", description: "Relative path to the file" },
                    symbolsOnly: { type: "boolean", description: "Return only exports" },
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
    if (RUN_MODE === "mcp") {
        console.log("\n[ 2/4 ] MCP Lazy Loading mode selected...");
        console.log("       Start MCP server: npm run mcp:server");
        console.log("       Register the server in gemini-cli and call repo_index/read_file tools.");
        console.log("       This keeps heavyweight indexing and file reads out of prompt context.");
        const bench = {
            timestamp: new Date().toISOString(),
            targetDir: path.resolve(TARGET_DIR),
            filesIndexed,
            skeletonTokens,
            naiveTokens,
            totalSessionTokens: skeletonTokens,
            filesReadOnDemand: 0,
            fileTokens: 0,
            indexCacheEnabled: cacheStatus.enabled,
            indexCacheHit: cacheStatus.hit,
            indexCacheFile: cacheStatus.cacheFile,
            question: QUESTION,
            mode: "mcp-handoff — use npm run mcp:server with gemini-cli tools/call",
        };
        const mcpBenchPath = "benchmark-results-mcp.json";
        let existing = [];
        try {
            existing = JSON.parse(fs.readFileSync(mcpBenchPath, "utf-8"));
        }
        catch {
            // File may not exist yet; start a new benchmark log.
        }
        existing.push(bench);
        fs.writeFileSync(mcpBenchPath, JSON.stringify(existing, null, 2));
        console.log("\nBenchmark saved to benchmark-results-mcp.json");
        return;
    }
    if (RUN_MODE === "live") {
        console.log("\n[ 2/4 ] Starting live agentic loop (Gemini API)...");
        const model = ai.getGenerativeModel({
            model: "gemini-2.0-flash",
            tools: [{ functionDeclarations: tools }],
            systemInstruction: systemPrompt,
        });
        const chat = model.startChat();
        let result = await chat.sendMessage(QUESTION);
        let response = result.response;
        let filesRead = 0;
        let fileTokens = 0;
        // Handle tool calls in a loop
        let toolCalls = response.getFunctionCalls();
        while (toolCalls.length > 0) {
            const toolResults = [];
            for (const call of toolCalls) {
                if (call.name === "read_file") {
                    const args = call.args;
                    console.log(`       -> Agent calling read_file("${args.relativePath}")`);
                    try {
                        const readResult = (0, LazyFileReader_1.readFile)(path.join(TARGET_DIR, args.relativePath), {
                            baseDir: TARGET_DIR,
                            symbolsOnly: args.symbolsOnly,
                        });
                        filesRead++;
                        fileTokens += readResult.tokenEstimate;
                        toolResults.push({
                            functionResponse: {
                                name: "read_file",
                                response: { content: readResult.content },
                            },
                        });
                    }
                    catch (error) {
                        toolResults.push({
                            functionResponse: {
                                name: "read_file",
                                response: { error: error.message },
                            },
                        });
                    }
                }
            }
            result = await chat.sendMessage(toolResults);
            response = result.response;
            toolCalls = response.getFunctionCalls();
        }
        const totalTokens = skeletonTokens + fileTokens;
        const answer = response.text();
        console.log("\n========================================");
        console.log("  AGENT ANSWER");
        console.log("========================================");
        console.log(answer);
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
            indexCacheEnabled: cacheStatus.enabled,
            indexCacheHit: cacheStatus.hit,
            indexCacheFile: cacheStatus.cacheFile,
            question: QUESTION,
            mode: "live — Gemini 2.0 Flash + LazyFileReader",
        };
        let existing = [];
        try {
            existing = JSON.parse(fs.readFileSync("benchmark-results.json", "utf-8"));
        }
        catch { }
        existing.push(bench);
        fs.writeFileSync("benchmark-results.json", JSON.stringify(existing, null, 2));
        console.log("\nBenchmark saved to benchmark-results.json");
        return;
    }
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
        }
        catch (e) {
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
        indexCacheEnabled: cacheStatus.enabled,
        indexCacheHit: cacheStatus.hit,
        indexCacheFile: cacheStatus.cacheFile,
        question: QUESTION,
        mode: "mock — skeleton + lazy reader demonstrated without live API call",
    };
    let existing = [];
    try {
        existing = JSON.parse(fs.readFileSync("benchmark-results.json", "utf-8"));
    }
    catch {
        // File may not exist yet; start a new benchmark log.
    }
    existing.push(bench);
    fs.writeFileSync("benchmark-results.json", JSON.stringify(existing, null, 2));
    console.log("\nBenchmark saved to benchmark-results.json");
}
main().catch((e) => {
    console.error("UNHANDLED ERROR:", e);
    process.exit(1);
});
