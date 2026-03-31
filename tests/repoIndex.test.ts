import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  buildIndex,
  buildIndexWithCache,
  countNaiveTokens,
  formatIndexForPrompt,
  getIndexCacheStats,
  invalidateIndexCache,
} from "../src/repoIndex";

describe("repoIndex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-analyzer-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("returns empty index for empty directory", () => {
    const index = buildIndex(tmpDir);
    expect(Object.keys(index)).toHaveLength(0);
  });

  test("extracts exported function signatures", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sample.ts"),
      `export function sendMessage(room: string, msg: string): void {}\n`
    );
    const index = buildIndex(tmpDir);
    expect(Object.keys(index)).toHaveLength(1);
    const entry = Object.values(index)[0];
    expect(entry.exports[0].name).toBe("sendMessage");
    expect(entry.exports[0].params).toContain("room");
    expect(entry.exports[0].kind).toBe("function");
  });

  test("extracts class details including constructor and visibility", () => {
    fs.writeFileSync(
      path.join(tmpDir, "class.ts"),
      `export class Logger {
        constructor(private name: string) {}
        public log(msg: string): void {}
        protected internalLog(msg: string): void {}
        private privateMethod() {}
      }\n`
    );
    const index = buildIndex(tmpDir);
    const entry = Object.values(index)[0];
    expect(entry.exports[0].name).toBe("Logger");
    expect(entry.exports[0].params).toContain("constructor(name: string)");
    expect(entry.exports[0].params).toContain("public log(msg: string): void");
    expect(entry.exports[0].params).toContain("protected internalLog(msg: string): void");
    expect(entry.exports[0].params).not.toContain("privateMethod");
  });

  test("includes .tsx files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "Component.tsx"),
      `export function MyComponent() { return null; }\n`
    );
    const index = buildIndex(tmpDir);
    expect(Object.keys(index)).toContain("Component.tsx");
  });

  test("skips files with no exports", () => {
    fs.writeFileSync(
      path.join(tmpDir, "internal.ts"),
      `function notExported() {}\n`
    );
    const index = buildIndex(tmpDir);
    expect(Object.keys(index)).toHaveLength(0);
  });

  test("formatIndexForPrompt returns non-empty string for non-empty index", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sample.ts"),
      `export interface IRoom { id: string; name: string; }\n`
    );
    const index = buildIndex(tmpDir);
    const formatted = formatIndexForPrompt(index);
    expect(formatted).toContain("IRoom");
  });

  test("countNaiveTokens estimates token count", () => {
    fs.writeFileSync(
      path.join(tmpDir, "sample.ts"),
      `export function hello(): void {}\n`
    );
    const tokens = countNaiveTokens(tmpDir);
    expect(tokens).toBeGreaterThan(0);
  });

  test("reuses cache when source files are unchanged", () => {
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), `export function a(): void {}\n`);

    const cacheDir = path.join(tmpDir, ".cache");
    const first = buildIndexWithCache(tmpDir, { useCache: true, cacheDir });
    const second = buildIndexWithCache(tmpDir, { useCache: true, cacheDir });

    expect(first.cache.enabled).toBe(true);
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(Object.keys(first.index)).toEqual(Object.keys(second.index));
  });

  test("invalidates cache when an indexable file changes", () => {
    const filePath = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(filePath, `export function a(): void {}\n`);

    const cacheDir = path.join(tmpDir, ".cache");
    buildIndexWithCache(tmpDir, { useCache: true, cacheDir });
    fs.writeFileSync(filePath, `export function a(): void {}\nexport function b(): void {}\n`);
    const rebuilt = buildIndexWithCache(tmpDir, { useCache: true, cacheDir });

    expect(rebuilt.cache.hit).toBe(false);
    const entry = Object.values(rebuilt.index)[0];
    const exportNames = entry.exports.map(exp => exp.name);
    expect(exportNames).toContain("b");
  });

  test("supports explicit cache invalidation", () => {
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), `export function a(): void {}\n`);

    const cacheDir = path.join(tmpDir, ".cache");
    const warm = buildIndexWithCache(tmpDir, { useCache: true, cacheDir });
    expect(warm.cache.hit).toBe(false);

    const hot = buildIndexWithCache(tmpDir, { useCache: true, cacheDir });
    expect(hot.cache.hit).toBe(true);

    invalidateIndexCache(tmpDir, { cacheDir });

    const after = buildIndexWithCache(tmpDir, { useCache: true, cacheDir });
    expect(after.cache.hit).toBe(false);
  });

  test("returns index cache stats", () => {
    fs.writeFileSync(path.join(tmpDir, "sample.ts"), `export function a(): void {}\n`);

    const cacheDir = path.join(tmpDir, ".cache");
    buildIndexWithCache(tmpDir, { useCache: true, cacheDir });

    const stats = getIndexCacheStats(tmpDir, { cacheDir });
    expect(stats.memory.maxEntries).toBeGreaterThan(0);
    expect(stats.disk.cacheFile).toContain(".json");
    expect(stats.disk.exists).toBe(true);
  });
});