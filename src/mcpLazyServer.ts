import * as path from "path";
import { buildIndexWithCache, formatIndexForPrompt, getIndexCacheStats, invalidateIndexCache } from "./repoIndex";
import { clearReadFileCache, getReadFileCacheStats, readFile } from "./LazyFileReader";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, Json>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, Json>;
}

const SERVER_NAME = "rocket-chat-code-analyzer-mcp";
const SERVER_VERSION = "0.1.0";
const CONTENT_TYPE = "application/json";

const toolDefinitions = [
  {
    name: "repo_index",
    description:
      "Build and return a typed semantic skeleton for a repository directory. " +
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
    description:
      "Read a repository file on demand. Supports symbols-only and line-range reads to minimize tokens.",
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

function writeMessage(payload: JsonRpcSuccess | JsonRpcError): void {
  const body = JSON.stringify(payload);
  const header =
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
    `Content-Type: ${CONTENT_TYPE}\r\n\r\n`;
  process.stdout.write(header + body);
}

function ok(id: string | number | null, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id: string | number | null, code: number, message: string): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function asString(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: Json | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: Json | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asLineRange(value: Json | undefined): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const start = value[0];
  const end = value[1];
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return [start, end];
}

function handleToolCall(id: string | number | null, params?: ToolCallParams): void {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (!name) { fail(id, -32602, "Missing tool name"); return; }

  if (name === "repo_index") {
    const targetDir = asString(args.targetDir);
    if (!targetDir) { fail(id, -32602, "repo_index requires targetDir"); return; }
    try {
      const resolvedBaseDir = path.resolve(targetDir);
      const forceRefresh = asBoolean(args.forceRefresh) === true;
      const indexResult = buildIndexWithCache(resolvedBaseDir, { useCache: true, forceRefresh });
      const index = indexResult.index;
      const skeleton = formatIndexForPrompt(index);
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
    } catch (error: unknown) {
      fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (name === "read_file") {
    const relativePath = asString(args.path);
    const baseDir = asString(args.baseDir);
    if (!relativePath || !baseDir) { fail(id, -32602, "read_file requires path and baseDir"); return; }
    try {
      const result = readFile(path.join(baseDir, relativePath), {
        baseDir,
        maxLines: asNumber(args.maxLines),
        symbolsOnly: asBoolean(args.symbolsOnly),
        lineRange: asLineRange(args.lineRange),
      });
      ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (error: unknown) {
      fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (name === "index_cache_invalidate") {
    const targetDir = asString(args.targetDir);
    if (!targetDir) { fail(id, -32602, "index_cache_invalidate requires targetDir"); return; }
    try {
      invalidateIndexCache(path.resolve(targetDir));
      const clearFileCache = asBoolean(args.clearReadFileCache) === true;
      if (clearFileCache) {
        clearReadFileCache();
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
    } catch (error: unknown) {
      fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (name === "index_cache_stats") {
    const targetDir = asString(args.targetDir);
    if (!targetDir) { fail(id, -32602, "index_cache_stats requires targetDir"); return; }
    try {
      ok(id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            targetDir: path.resolve(targetDir),
            indexCache: getIndexCacheStats(path.resolve(targetDir)),
            readFileCache: getReadFileCacheStats(),
          }, null, 2),
        }],
      });
    } catch (error: unknown) {
      fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  fail(id, -32601, `Unknown tool: ${name}`);
}

function handleRequest(request: JsonRpcRequest): void {
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
      handleToolCall(id, request.params as ToolCallParams | undefined);
      return;
    default:
      fail(id, -32601, `Method not found: ${request.method}`);
  }
}

let inputBuffer = Buffer.alloc(0);

function parseIncomingBuffer(): void {
  while (true) {
    const preview = inputBuffer.toString("utf8", 0, Math.min(inputBuffer.length, 32)).trimStart();
    const likelyFramed = preview.startsWith("Content-Length:");

    if (likelyFramed) {
      const marker = inputBuffer.indexOf("\r\n\r\n");
      if (marker < 0) return;

      const headerText = inputBuffer.slice(0, marker).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.slice(marker + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const frameLength = marker + 4 + contentLength;
      if (inputBuffer.length < frameLength) return;

      const body = inputBuffer.slice(marker + 4, frameLength).toString("utf8");
      inputBuffer = inputBuffer.slice(frameLength);

      try {
        const request = JSON.parse(body) as JsonRpcRequest;
        handleRequest(request);
      } catch {
        fail(null, -32700, "Parse error");
      }
      continue;
    }

    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) return;

    const line = inputBuffer.slice(0, newline).toString("utf8").trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;

    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      handleRequest(request);
    } catch {
      fail(null, -32700, "Parse error");
    }
  }
}

process.stdin.on("data", (chunk: Buffer | string) => {
  const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  inputBuffer = Buffer.concat([inputBuffer, piece]);
  parseIncomingBuffer();
});

process.stdin.on("error", () => process.exit(1));