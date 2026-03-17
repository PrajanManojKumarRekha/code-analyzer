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