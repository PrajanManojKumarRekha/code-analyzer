import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { readFile } from "../src/LazyFileReader";

describe("LazyFileReader", () => {
  let tmpDir: string;
  let sampleFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-file-reader-test-"));
    sampleFilePath = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(
      sampleFilePath,
      [
        "export interface IUser { id: string; name: string; }",
        "export function getUser(id: string): IUser {",
        "  return { id, name: 'Test' };",
        "}",
        "export const version = '1.0.0';",
        "// line 6",
        "// line 7",
        "// line 8",
        "// line 9",
        "// line 10",
      ].join("\n")
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads full file when no options provided", () => {
    const result = readFile(sampleFilePath, { baseDir: tmpDir });
    expect(result.mode).toBe("full");
    expect(result.totalLines).toBe(10);
    expect(result.content).toContain("export interface IUser");
  });

  test("caps lines when maxLines is set", () => {
    const result = readFile(sampleFilePath, { maxLines: 3, baseDir: tmpDir });
    expect(result.mode).toBe("capped");
    expect(result.linesReturned).toBe(3);
    expect(result.content).toContain("export interface IUser");
    expect(result.content).not.toContain("export const version");
    expect(result.content).toContain("// ... [7 more lines");
  });

  test("reads specific line range", () => {
    const result = readFile(sampleFilePath, { lineRange: [2, 4], baseDir: tmpDir });
    expect(result.mode).toBe("line-range");
    expect(result.linesReturned).toBe(3);
    expect(result.content).toContain("export function getUser");
    expect(result.content).toContain("return { id, name: 'Test' };");
    expect(result.content).toContain("}");
    expect(result.content).not.toContain("export interface IUser");
  });

  test("extracts symbols only", () => {
    const result = readFile(sampleFilePath, { symbolsOnly: true, baseDir: tmpDir });
    expect(result.mode).toBe("symbols-only");
    expect(result.content).toContain("export interface IUser");
    expect(result.content).toContain("export function getUser");
    expect(result.content).not.toContain("return { id, name: 'Test' };");
  });

  test("prevents path traversal", () => {
    const outsideFile = path.join(os.tmpdir(), "outside.txt");
    fs.writeFileSync(outsideFile, "secret");
    
    expect(() => {
      readFile(outsideFile, { baseDir: tmpDir });
    }).toThrow("Path escapes baseDir");

    fs.unlinkSync(outsideFile);
  });

  test("throws error for non-existent file", () => {
    expect(() => {
      readFile(path.join(tmpDir, "non-existent.ts"), { baseDir: tmpDir });
    }).toThrow("File not found");
  });

  test("throws error for binary file", () => {
    const binaryFile = path.join(tmpDir, "binary.bin");
    fs.writeFileSync(binaryFile, Buffer.from([0, 1, 2, 0, 3]));
    expect(() => {
      readFile(binaryFile, { baseDir: tmpDir });
    }).toThrow("Binary file");
  });
});
