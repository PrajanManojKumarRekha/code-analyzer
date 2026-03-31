import * as fs from "fs";
import * as path from "path";
import { Project } from "ts-morph";
import { CacheManager } from "./CacheManager";

export interface ReadFileOptions {
  maxLines?: number;        // default 300
  symbolsOnly?: boolean;    // return only exported signatures, no implementation
  lineRange?: [number, number]; // [start, end] inclusive, 1-indexed
  baseDir?: string;         // default process.cwd(), used to prevent path traversal
  useCache?: boolean;       // default true
}

export interface ReadFileResult {
  path: string;
  content: string;
  linesReturned: number;
  totalLines: number;
  tokenEstimate: number;
  mode: "full" | "capped" | "symbols-only" | "line-range";
}

interface RawFileSnapshot {
  raw: string;
  allLines: string[];
  totalLines: number;
  size: number;
  mtimeMs: number;
}

interface SymbolsSnapshot {
  content: string;
  size: number;
  mtimeMs: number;
}

const rawFileCache = new CacheManager<RawFileSnapshot>({ maxEntries: 500, ttlMs: 5 * 60_000 });
const symbolsCache = new CacheManager<SymbolsSnapshot>({ maxEntries: 300, ttlMs: 10 * 60_000 });

export interface ReadFileCacheStats {
  raw: {
    size: number;
    maxEntries: number;
    ttlMs: number;
  };
  symbols: {
    size: number;
    maxEntries: number;
    ttlMs: number;
  };
}

export function clearReadFileCache(): void {
  rawFileCache.clear();
  symbolsCache.clear();
}

export function getReadFileCacheStats(): ReadFileCacheStats {
  return {
    raw: rawFileCache.stats(),
    symbols: symbolsCache.stats(),
  };
}

function loadRawSnapshot(filePath: string, useCache: boolean): RawFileSnapshot {
  const stats = fs.statSync(filePath);
  const cached = useCache ? rawFileCache.get(filePath) : undefined;

  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached;
  }

  const raw = fs.readFileSync(filePath, "utf-8");

  // Binary check
  if (raw.includes("\0")) {
    throw new Error(`Binary file, cannot read: ${filePath}`);
  }

  const allLines = raw.split("\n");
  const snapshot: RawFileSnapshot = {
    raw,
    allLines,
    totalLines: allLines.length,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };

  if (useCache) {
    rawFileCache.set(filePath, snapshot);
  }

  return snapshot;
}

export function readFile(filePath: string, options: ReadFileOptions = {}): ReadFileResult {
  const { maxLines = 300, symbolsOnly = false, lineRange, baseDir = process.cwd(), useCache = true } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const snapshot = loadRawSnapshot(filePath, useCache);
  const { raw, allLines, totalLines, mtimeMs, size } = snapshot;

  // Prevent path traversal by requiring the file to live under baseDir.
  const resolved = path.resolve(filePath);
  const resolvedBaseDir = path.resolve(baseDir);
  const inBaseDir = resolved === resolvedBaseDir || resolved.startsWith(resolvedBaseDir + path.sep);
  if (!inBaseDir) {
    throw new Error(`Path escapes baseDir: ${filePath}`);
  }

  if (symbolsOnly) {
    const symbolsKey = `${filePath}::${size}::${mtimeMs}`;
    const cachedSymbols = useCache ? symbolsCache.get(symbolsKey) : undefined;

    if (cachedSymbols) {
      return {
        path: filePath,
        content: cachedSymbols.content,
        linesReturned: cachedSymbols.content.split("\n").length,
        totalLines,
        tokenEstimate: Math.round(cachedSymbols.content.length / 4),
        mode: "symbols-only",
      };
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const sf = project.addSourceFileAtPath(filePath);
    const lines: string[] = [`// symbols-only mode: ${path.basename(filePath)}`];

    for (const fn of sf.getFunctions()) {
      if (!fn.isExported()) continue;
      const params = fn.getParameters().map(p => `${p.getName()}: ${p.getType().getText()}`).join(", ");
      lines.push(`export function ${fn.getName()}(${params}): ${fn.getReturnType().getText()}`);
    }
    for (const iface of sf.getInterfaces()) {
      if (!iface.isExported()) continue;
      const props = iface.getProperties()
        .map(p => `  ${p.getName()}${p.hasQuestionToken() ? "?" : ""}: ${p.getType().getText()}`)
        .join(";\n");
      lines.push(`export interface ${iface.getName()} {\n${props}\n}`);
    }
    for (const ta of sf.getTypeAliases()) {
      if (!ta.isExported()) continue;
      lines.push(`export type ${ta.getName()} = ${ta.getType().getText().slice(0, 200)}`);
    }

    const content = lines.join("\n");
    if (useCache) {
      symbolsCache.set(symbolsKey, { content, size, mtimeMs });
    }

    return {
      path: filePath,
      content,
      linesReturned: lines.length,
      totalLines,
      tokenEstimate: Math.round(content.length / 4),
      mode: "symbols-only",
    };
  }

  if (lineRange) {
    const [start, end] = lineRange;
    const sliced = allLines.slice(start - 1, end);
    const content = sliced.join("\n");
    return {
      path: filePath,
      content,
      linesReturned: sliced.length,
      totalLines,
      tokenEstimate: Math.round(content.length / 4),
      mode: "line-range",
    };
  }

  if (totalLines <= maxLines) {
    return {
      path: filePath,
      content: raw,
      linesReturned: totalLines,
      totalLines,
      tokenEstimate: Math.round(raw.length / 4),
      mode: "full",
    };
  }

  const capped = allLines.slice(0, maxLines).join("\n");
  return {
    path: filePath,
    content: capped + `\n\n// ... [${totalLines - maxLines} more lines, use lineRange to read further]`,
    linesReturned: maxLines,
    totalLines,
    tokenEstimate: Math.round(capped.length / 4),
    mode: "capped",
  };
}