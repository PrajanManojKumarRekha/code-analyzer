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
const path = __importStar(require("path"));
const repoIndex_1 = require("./repoIndex");
const LazyFileReader_1 = require("./LazyFileReader");
const SERVER_NAME = "rocket-chat-code-analyzer-mcp";
const SERVER_VERSION = "0.1.0";
const CONTENT_TYPE = "application/json";
const toolDefinitions = [
    {
        name: "repo_index",
        description: "Build and return a typed semantic skeleton for a repository directory. " +
            "Use at session start to reduce token usage before reading implementation files.",
        inputSchema: {
            type: "object",
            properties: {
                targetDir: { type: "string", description: "Directory path to index" },
                forceRefresh: { type: "boolean", description: "Bypass index cache and rebuild" },
            },
            required: ["targetDir"],
        },
    },
    {
        name: "read_file",
        description: "Read a repository file on demand. Supports symbols-only and line-range reads to minimize tokens.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Relative path returned by repo_index" },
                baseDir: { type: "string", description: "Base directory used by repo_index" },
                maxLines: { type: "number", description: "Line cap, default 300" },
                symbolsOnly: { type: "boolean", description: "Return exported signatures only" },
                lineRange: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 2,
                    maxItems: 2,
                    description: "Inclusive [start, end] range, 1-indexed",
                },
            },
            required: ["path", "baseDir"],
        },
    },
    {
        name: "index_cache_invalidate",
        description: "Invalidate cached repository index data and optionally clear read_file cache.",
        inputSchema: {
            type: "object",
            properties: {
                targetDir: { type: "string", description: "Directory path used by repo_index" },
                clearReadFileCache: { type: "boolean", description: "Also clear LazyFileReader caches" },
            },
            required: ["targetDir"],
        },
    },
    {
        name: "index_cache_stats",
        description: "Return memory and disk cache stats for repo_index and read_file caches.",
        inputSchema: {
            type: "object",
            properties: {
                targetDir: { type: "string", description: "Directory path used by repo_index" },
            },
            required: ["targetDir"],
        },
    },
];
function writeMessage(payload) {
    const body = JSON.stringify(payload);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
        `Content-Type: ${CONTENT_TYPE}\r\n\r\n`;
    process.stdout.write(header + body);
}
function ok(id, result) {
    writeMessage({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
    writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code, message },
    });
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asNumber(value) {
    return typeof value === "number" ? value : undefined;
}
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function asLineRange(value) {
    if (!Array.isArray(value) || value.length !== 2)
        return undefined;
    const start = value[0];
    const end = value[1];
    if (typeof start !== "number" || typeof end !== "number")
        return undefined;
    return [start, end];
}
function handleToolCall(id, params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!name) {
        fail(id, -32602, "Missing tool name");
        return;
    }
    if (name === "repo_index") {
        const targetDir = asString(args.targetDir);
        if (!targetDir) {
            fail(id, -32602, "repo_index requires targetDir");
            return;
        }
        try {
            const resolvedBaseDir = path.resolve(targetDir);
            const forceRefresh = asBoolean(args.forceRefresh) === true;
            const indexResult = (0, repoIndex_1.buildIndexWithCache)(resolvedBaseDir, { useCache: true, forceRefresh });
            const index = indexResult.index;
            const skeleton = (0, repoIndex_1.formatIndexForPrompt)(index);
            ok(id, {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            baseDir: resolvedBaseDir,
                            filesIndexed: Object.keys(index).length,
                            skeleton,
                            cache: indexResult.cache,
                        }, null, 2),
                    }],
            });
        }
        catch (error) {
            fail(id, -32603, error instanceof Error ? error.message : String(error));
        }
        return;
    }
    if (name === "read_file") {
        const relativePath = asString(args.path);
        const baseDir = asString(args.baseDir);
        if (!relativePath || !baseDir) {
            fail(id, -32602, "read_file requires path and baseDir");
            return;
        }
        try {
            const result = (0, LazyFileReader_1.readFile)(path.join(baseDir, relativePath), {
                baseDir,
                maxLines: asNumber(args.maxLines),
                symbolsOnly: asBoolean(args.symbolsOnly),
                lineRange: asLineRange(args.lineRange),
            });
            ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        }
        catch (error) {
            fail(id, -32603, error instanceof Error ? error.message : String(error));
        }
        return;
    }
    if (name === "index_cache_invalidate") {
        const targetDir = asString(args.targetDir);
        if (!targetDir) {
            fail(id, -32602, "index_cache_invalidate requires targetDir");
            return;
        }
        try {
            (0, repoIndex_1.invalidateIndexCache)(path.resolve(targetDir));
            const clearFileCache = asBoolean(args.clearReadFileCache) === true;
            if (clearFileCache) {
                (0, LazyFileReader_1.clearReadFileCache)();
            }
            ok(id, {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            targetDir: path.resolve(targetDir),
                            indexCacheInvalidated: true,
                            readFileCacheCleared: clearFileCache,
                        }, null, 2),
                    }],
            });
        }
        catch (error) {
            fail(id, -32603, error instanceof Error ? error.message : String(error));
        }
        return;
    }
    if (name === "index_cache_stats") {
        const targetDir = asString(args.targetDir);
        if (!targetDir) {
            fail(id, -32602, "index_cache_stats requires targetDir");
            return;
        }
        try {
            ok(id, {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            targetDir: path.resolve(targetDir),
                            indexCache: (0, repoIndex_1.getIndexCacheStats)(path.resolve(targetDir)),
                            readFileCache: (0, LazyFileReader_1.getReadFileCacheStats)(),
                        }, null, 2),
                    }],
            });
        }
        catch (error) {
            fail(id, -32603, error instanceof Error ? error.message : String(error));
        }
        return;
    }
    fail(id, -32601, `Unknown tool: ${name}`);
}
function handleRequest(request) {
    const id = request.id ?? null;
    switch (request.method) {
        case "initialize":
            ok(id, {
                protocolVersion: "2024-11-05",
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                capabilities: { tools: {} },
            });
            return;
        case "notifications/initialized":
            return;
        case "tools/list":
            ok(id, { tools: toolDefinitions });
            return;
        case "tools/call":
            handleToolCall(id, request.params);
            return;
        default:
            fail(id, -32601, `Method not found: ${request.method}`);
    }
}
let inputBuffer = Buffer.alloc(0);
function parseIncomingBuffer() {
    while (true) {
        const preview = inputBuffer.toString("utf8", 0, Math.min(inputBuffer.length, 32)).trimStart();
        const likelyFramed = preview.startsWith("Content-Length:");
        if (likelyFramed) {
            const marker = inputBuffer.indexOf("\r\n\r\n");
            if (marker < 0)
                return;
            const headerText = inputBuffer.slice(0, marker).toString("utf8");
            const match = headerText.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                inputBuffer = inputBuffer.slice(marker + 4);
                continue;
            }
            const contentLength = Number.parseInt(match[1], 10);
            const frameLength = marker + 4 + contentLength;
            if (inputBuffer.length < frameLength)
                return;
            const body = inputBuffer.slice(marker + 4, frameLength).toString("utf8");
            inputBuffer = inputBuffer.slice(frameLength);
            try {
                const request = JSON.parse(body);
                handleRequest(request);
            }
            catch {
                fail(null, -32700, "Parse error");
            }
            continue;
        }
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0)
            return;
        const line = inputBuffer.slice(0, newline).toString("utf8").trim();
        inputBuffer = inputBuffer.slice(newline + 1);
        if (!line)
            continue;
        try {
            const request = JSON.parse(line);
            handleRequest(request);
        }
        catch {
            fail(null, -32700, "Parse error");
        }
    }
}
process.stdin.on("data", (chunk) => {
    const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    inputBuffer = Buffer.concat([inputBuffer, piece]);
    parseIncomingBuffer();
});
process.stdin.on("error", () => process.exit(1));
