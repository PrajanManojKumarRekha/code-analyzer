import { Project, SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { CacheManager } from "./CacheManager";

export interface TypedSignature {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "const";
  params: string;
  returnType: string;
  docstring?: string;
}

export interface IndexEntry {
  relativePath: string;
  sizeKb: number;
  exports: TypedSignature[];
  packageName?: string;
}

export type RepoIndex = Record<string, IndexEntry>;

export interface BuildIndexOptions {
  useCache?: boolean;
  cacheDir?: string;
  cacheKey?: string;
  forceRefresh?: boolean;
}

export interface IndexCacheStatus {
  enabled: boolean;
  hit: boolean;
  layer?: "memory" | "disk" | "rebuild";
  cacheFile?: string;
  fingerprint?: string;
}

export interface BuildIndexWithCacheResult {
  index: RepoIndex;
  cache: IndexCacheStatus;
}

interface IndexCachePayload {
  version: number;
  targetDir: string;
  fingerprint: string;
  generatedAt: string;
  index: RepoIndex;
}

export interface IndexCacheStats {
  memory: {
    size: number;
    maxEntries: number;
    ttlMs: number;
  };
  disk: {
    cacheFile: string;
    exists: boolean;
  };
}

const INDEX_CACHE_VERSION = 1;
const memoryIndexCache = new CacheManager<IndexCachePayload>({ maxEntries: 64, ttlMs: 15 * 60_000 });

function getPackageName(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.name;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function extractSignatures(sourceFile: SourceFile): TypedSignature[] {
  const sigs: TypedSignature[] = [];

  // Exported functions
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const params = fn.getParameters()
      .map(p => `${p.getName()}: ${p.getType().getText()}`)
      .join(", ");
    sigs.push({
      name: fn.getName() || "anonymous",
      kind: "function",
      params,
      returnType: fn.getReturnType().getText(),
      docstring: fn.getJsDocs().map(d => d.getComment()).join(" ").slice(0, 120) || undefined,
    });
  }

  // Exported classes
  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue;
    
    const details: string[] = [];

    // Constructor
    for (const ctor of cls.getConstructors()) {
      const params = ctor.getParameters()
        .map(p => `${p.getName()}: ${p.getType().getText()}`)
        .join(", ");
      details.push(`constructor(${params})`);
    }

    // Methods
    const methods = cls.getMethods()
      .filter(m => m.getScope() === undefined || m.getScope() === "public" || m.getScope() === "protected")
      .slice(0, 5)
      .map(m => {
        const scope = m.getScope() ? `${m.getScope()} ` : "";
        const params = m.getParameters()
          .map(p => `${p.getName()}: ${p.getType().getText()}`)
          .join(", ");
        return `${scope}${m.getName()}(${params}): ${m.getReturnType().getText()}`;
      });
    
    details.push(...methods);

    sigs.push({
      name: cls.getName() || "AnonymousClass",
      kind: "class",
      params: details.join(" | "),
      returnType: "",
    });
  }

  // Exported interfaces
  for (const iface of sourceFile.getInterfaces()) {
    if (!iface.isExported()) continue;
    const props = iface.getProperties()
      .slice(0, 8)
      .map(p => `${p.getName()}${p.hasQuestionToken() ? "?" : ""}: ${p.getType().getText()}`)
      .join("; ");
    sigs.push({
      name: iface.getName(),
      kind: "interface",
      params: props,
      returnType: "",
    });
  }

  // Exported type aliases
  for (const ta of sourceFile.getTypeAliases()) {
    if (!ta.isExported()) continue;
    sigs.push({
      name: ta.getName(),
      kind: "type",
      params: ta.getType().getText().slice(0, 200),
      returnType: "",
    });
  }

  // Exported enums
  for (const en of sourceFile.getEnums()) {
    if (!en.isExported()) continue;
    const members = en.getMembers().map(m => m.getName()).join(", ");
    sigs.push({
      name: en.getName(),
      kind: "enum",
      params: members,
      returnType: "",
    });
  }

  return sigs;
}

function collectSourceFiles(targetDir: string): string[] {
  const tsFiles: string[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".spec.ts")
      ) {
        tsFiles.push(full);
      }
    }
  }

  walk(targetDir);
  tsFiles.sort();
  return tsFiles;
}

function buildIndexFromFiles(targetDir: string, sourceFiles: string[]): RepoIndex {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, skipLibCheck: true },
  });

  project.addSourceFilesAtPaths(sourceFiles);

  const index: RepoIndex = {};

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const relative = path.relative(targetDir, filePath).replace(/\\/g, "/");
    const stats = fs.statSync(filePath);
    const sizeKb = Math.round((stats.size / 1024) * 10) / 10;
    const exports = extractSignatures(sf);

    if (exports.length === 0) continue; // skip files with no exports

    index[relative] = {
      relativePath: relative,
      sizeKb,
      exports,
      packageName: getPackageName(filePath),
    };
  }

  return index;
}

function computeFingerprint(targetDir: string, sourceFiles: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(`v${INDEX_CACHE_VERSION}|${path.resolve(targetDir)}`);

  for (const absoluteFile of sourceFiles) {
    const stats = fs.statSync(absoluteFile);
    const relative = path.relative(targetDir, absoluteFile).replace(/\\/g, "/");
    hash.update(`${relative}|${stats.size}|${stats.mtimeMs}`);
  }

  return hash.digest("hex");
}

function getCacheFilePath(targetDir: string, options: BuildIndexOptions): string {
  const cacheRoot = path.resolve(options.cacheDir ?? path.join(process.cwd(), ".cache", "repo-index"));
  const cacheSeed = options.cacheKey ?? path.resolve(targetDir);
  const cacheId = crypto.createHash("sha256").update(cacheSeed).digest("hex").slice(0, 16);
  fs.mkdirSync(cacheRoot, { recursive: true });
  return path.join(cacheRoot, `${cacheId}.json`);
}

function readCache(cacheFile: string): IndexCachePayload | undefined {
  if (!fs.existsSync(cacheFile)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as IndexCachePayload;
  } catch {
    return undefined;
  }
}

function writeCache(cacheFile: string, payload: IndexCachePayload): void {
  fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2));
}

function getMemoryCacheKey(targetDir: string, options: BuildIndexOptions): string {
  return options.cacheKey ?? path.resolve(targetDir);
}

export function invalidateIndexCache(targetDir?: string, options: BuildIndexOptions = {}): void {
  if (!targetDir) {
    memoryIndexCache.clear();
    return;
  }

  const resolvedTargetDir = path.resolve(targetDir);
  const memoryKey = getMemoryCacheKey(resolvedTargetDir, options);
  memoryIndexCache.delete(memoryKey);

  const cacheFile = getCacheFilePath(resolvedTargetDir, options);
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
  }
}

export function getIndexCacheStats(targetDir: string, options: BuildIndexOptions = {}): IndexCacheStats {
  const resolvedTargetDir = path.resolve(targetDir);
  const cacheFile = getCacheFilePath(resolvedTargetDir, options);
  return {
    memory: memoryIndexCache.stats(),
    disk: {
      cacheFile,
      exists: fs.existsSync(cacheFile),
    },
  };
}

export function buildIndex(targetDir: string): RepoIndex {
  return buildIndexWithCache(targetDir, { useCache: false }).index;
}

export function buildIndexWithCache(targetDir: string, options: BuildIndexOptions = {}): BuildIndexWithCacheResult {
  const resolvedTargetDir = path.resolve(targetDir);
  const sourceFiles = collectSourceFiles(resolvedTargetDir);
  const useCache = options.useCache === true;

  if (!useCache) {
    return {
      index: buildIndexFromFiles(resolvedTargetDir, sourceFiles),
      cache: { enabled: false, hit: false },
    };
  }

  const fingerprint = computeFingerprint(resolvedTargetDir, sourceFiles);
  const cacheFile = getCacheFilePath(resolvedTargetDir, options);
  const memoryKey = getMemoryCacheKey(resolvedTargetDir, options);

  const inMemory = options.forceRefresh ? undefined : memoryIndexCache.get(memoryKey);
  if (
    inMemory &&
    inMemory.version === INDEX_CACHE_VERSION &&
    inMemory.targetDir === resolvedTargetDir &&
    inMemory.fingerprint === fingerprint
  ) {
    return {
      index: inMemory.index,
      cache: { enabled: true, hit: true, cacheFile, fingerprint, layer: "memory" },
    };
  }

  const cached = options.forceRefresh ? undefined : readCache(cacheFile);

  if (
    cached &&
    cached.version === INDEX_CACHE_VERSION &&
    cached.targetDir === resolvedTargetDir &&
    cached.fingerprint === fingerprint
  ) {
    memoryIndexCache.set(memoryKey, cached);
    return {
      index: cached.index,
      cache: { enabled: true, hit: true, cacheFile, fingerprint, layer: "disk" },
    };
  }

  const index = buildIndexFromFiles(resolvedTargetDir, sourceFiles);
  writeCache(cacheFile, {
    version: INDEX_CACHE_VERSION,
    targetDir: resolvedTargetDir,
    fingerprint,
    generatedAt: new Date().toISOString(),
    index,
  });
  memoryIndexCache.set(memoryKey, {
    version: INDEX_CACHE_VERSION,
    targetDir: resolvedTargetDir,
    fingerprint,
    generatedAt: new Date().toISOString(),
    index,
  });

  return {
    index,
    cache: { enabled: true, hit: false, cacheFile, fingerprint, layer: "rebuild" },
  };
}

export function formatIndexForPrompt(index: RepoIndex): string {
  const lines: string[] = [];

  for (const [filePath, entry] of Object.entries(index)) {
    const pkg = entry.packageName ? ` [${entry.packageName}]` : "";
    lines.push(`\n"${filePath}"${pkg} (${entry.sizeKb}kb)`);
    for (const sig of entry.exports) {
      let line = "";
      if (sig.kind === "function") {
        line = `  ${sig.name}(${sig.params}): ${sig.returnType}`;
      } else if (sig.kind === "interface") {
        line = `  interface ${sig.name} { ${sig.params} }`;
      } else if (sig.kind === "class") {
        line = `  class ${sig.name} — methods: ${sig.params}`;
      } else if (sig.kind === "type") {
        line = `  type ${sig.name} = ${sig.params}`;
      } else if (sig.kind === "enum") {
        line = `  enum ${sig.name} { ${sig.params} }`;
      }
      if (sig.docstring) line += `  // ${sig.docstring}`;
      lines.push(line);
    }
  }

  return lines.join("\n");
}

export function countNaiveTokens(targetDir: string): number {
  let total = 0;
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
        try {
          const content = fs.readFileSync(full, "utf-8");
          total += Math.round(content.length / 4);
        } catch {}
      }
    }
  }
  walk(targetDir);
  return total;
}