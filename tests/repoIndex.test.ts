import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { buildIndex, formatIndexForPrompt, countNaiveTokens } from "../src/repoIndex";

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
});