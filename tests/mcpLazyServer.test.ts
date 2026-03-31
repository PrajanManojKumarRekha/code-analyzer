import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, (value: JsonRpcResponse) => void>();
  private nextId = 1;

  constructor(cwd: string) {
    const tsxCli = path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
    this.proc = spawn(process.execPath, [tsxCli, "src/mcpLazyServer.ts"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseFrames();
    });
  }

  private parseFrames(): void {
    while (true) {
      const marker = this.buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;

      const headerText = this.buffer.slice(0, marker).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(marker + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const frameLength = marker + 4 + contentLength;
      if (this.buffer.length < frameLength) return;

      const body = this.buffer.slice(marker + 4, frameLength).toString("utf8");
      this.buffer = this.buffer.slice(frameLength);

      const parsed = JSON.parse(body) as JsonRpcResponse;
      if (typeof parsed.id === "number") {
        const resolver = this.pending.get(parsed.id);
        if (resolver) {
          this.pending.delete(parsed.id);
          resolver(parsed);
        }
      }
    }
  }

  private writeFrame(request: JsonRpcRequest): void {
    const json = JSON.stringify(request);
    const payload =
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n` +
      "Content-Type: application/json\r\n\r\n" +
      json;
    this.proc.stdin.write(payload);
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.writeFrame(req);
    return new Promise(resolve => {
      this.pending.set(id, resolve);
    });
  }

  notify(method: string, params?: unknown): void {
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    this.writeFrame(req);
  }

  stop(): void {
    this.proc.kill();
  }
}

describe("mcpLazyServer", () => {
  jest.setTimeout(30000);

  const repoRoot = path.resolve(__dirname, "..");
  let tmpDir: string;
  let client: McpStdioClient | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lazy-server-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "sample.ts"),
      [
        "export interface IRoom { id: string; name: string; }",
        "export function sendMessage(room: IRoom, msg: string): string {",
        "  return `${room.id}:${msg}`;",
        "}",
      ].join("\n")
    );
    client = new McpStdioClient(repoRoot);
  });

  afterEach(() => {
    client?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("initialize, list tools, and call repo_index/read_file", async () => {
    const c = client;
    expect(c).toBeDefined();
    if (!c) {
      throw new Error("MCP test client was not initialized");
    }

    const init = await c.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jest", version: "1.0.0" },
    });
    expect(init.error).toBeUndefined();

    c.notify("notifications/initialized", {});

    const list = await c.request("tools/list", {});
    expect(list.error).toBeUndefined();
    const listResult = list.result as { tools: Array<{ name: string }> };
    const toolNames = listResult.tools.map(t => t.name);
    expect(toolNames).toContain("repo_index");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("index_cache_invalidate");
    expect(toolNames).toContain("index_cache_stats");

    const indexCall = await c.request("tools/call", {
      name: "repo_index",
      arguments: { targetDir: tmpDir },
    });
    expect(indexCall.error).toBeUndefined();
    const indexResult = indexCall.result as { content: Array<{ type: string; text: string }> };
    const indexPayload = JSON.parse(indexResult.content[0].text) as {
      baseDir: string;
      filesIndexed: number;
      skeleton: string;
      cache: {
        enabled: boolean;
        hit: boolean;
      };
    };

    expect(indexPayload.filesIndexed).toBe(1);
    expect(indexPayload.skeleton).toContain("sendMessage");
    expect(indexPayload.cache.enabled).toBe(true);

    const fileCall = await c.request("tools/call", {
      name: "read_file",
      arguments: {
        baseDir: indexPayload.baseDir,
        path: "sample.ts",
        symbolsOnly: true,
      },
    });
    expect(fileCall.error).toBeUndefined();
    const fileResult = fileCall.result as { content: Array<{ type: string; text: string }> };
    const filePayload = JSON.parse(fileResult.content[0].text) as {
      content: string;
      mode: string;
    };

    expect(filePayload.mode).toBe("symbols-only");
    expect(filePayload.content).toContain("export function sendMessage");

    const cacheStats = await c.request("tools/call", {
      name: "index_cache_stats",
      arguments: { targetDir: tmpDir },
    });
    expect(cacheStats.error).toBeUndefined();

    const invalidate = await c.request("tools/call", {
      name: "index_cache_invalidate",
      arguments: { targetDir: tmpDir, clearReadFileCache: true },
    });
    expect(invalidate.error).toBeUndefined();
  });
});
