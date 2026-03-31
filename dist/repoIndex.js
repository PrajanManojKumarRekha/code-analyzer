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
exports.invalidateIndexCache = invalidateIndexCache;
exports.getIndexCacheStats = getIndexCacheStats;
exports.buildIndex = buildIndex;
exports.buildIndexWithCache = buildIndexWithCache;
exports.formatIndexForPrompt = formatIndexForPrompt;
exports.countNaiveTokens = countNaiveTokens;
const ts_morph_1 = require("ts-morph");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const CacheManager_1 = require("./CacheManager");
const INDEX_CACHE_VERSION = 1;
const memoryIndexCache = new CacheManager_1.CacheManager({ maxEntries: 64, ttlMs: 15 * 60_000 });
function getPackageName(filePath) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 6; i++) {
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                return pkg.name;
            }
            catch {
                return undefined;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return undefined;
}
function extractSignatures(sourceFile) {
    const sigs = [];
    // Exported functions
    for (const fn of sourceFile.getFunctions()) {
        if (!fn.isExported())
            continue;
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
        if (!cls.isExported())
            continue;
        const details = [];
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
        if (!iface.isExported())
            continue;
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
        if (!ta.isExported())
            continue;
        sigs.push({
            name: ta.getName(),
            kind: "type",
            params: ta.getType().getText().slice(0, 200),
            returnType: "",
        });
    }
    // Exported enums
    for (const en of sourceFile.getEnums()) {
        if (!en.isExported())
            continue;
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
function collectSourceFiles(targetDir) {
    const tsFiles = [];
    function walk(dir) {
        if (!fs.existsSync(dir))
            return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git")
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
                !entry.name.endsWith(".d.ts") &&
                !entry.name.endsWith(".test.ts") &&
                !entry.name.endsWith(".spec.ts")) {
                tsFiles.push(full);
            }
        }
    }
    walk(targetDir);
    tsFiles.sort();
    return tsFiles;
}
function buildIndexFromFiles(targetDir, sourceFiles) {
    const project = new ts_morph_1.Project({
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: false, skipLibCheck: true },
    });
    project.addSourceFilesAtPaths(sourceFiles);
    const index = {};
    for (const sf of project.getSourceFiles()) {
        const filePath = sf.getFilePath();
        const relative = path.relative(targetDir, filePath).replace(/\\/g, "/");
        const stats = fs.statSync(filePath);
        const sizeKb = Math.round((stats.size / 1024) * 10) / 10;
        const exports = extractSignatures(sf);
        if (exports.length === 0)
            continue; // skip files with no exports
        index[relative] = {
            relativePath: relative,
            sizeKb,
            exports,
            packageName: getPackageName(filePath),
        };
    }
    return index;
}
function computeFingerprint(targetDir, sourceFiles) {
    const hash = crypto.createHash("sha256");
    hash.update(`v${INDEX_CACHE_VERSION}|${path.resolve(targetDir)}`);
    for (const absoluteFile of sourceFiles) {
        const stats = fs.statSync(absoluteFile);
        const relative = path.relative(targetDir, absoluteFile).replace(/\\/g, "/");
        hash.update(`${relative}|${stats.size}|${stats.mtimeMs}`);
    }
    return hash.digest("hex");
}
function getCacheFilePath(targetDir, options) {
    const cacheRoot = path.resolve(options.cacheDir ?? path.join(process.cwd(), ".cache", "repo-index"));
    const cacheSeed = options.cacheKey ?? path.resolve(targetDir);
    const cacheId = crypto.createHash("sha256").update(cacheSeed).digest("hex").slice(0, 16);
    fs.mkdirSync(cacheRoot, { recursive: true });
    return path.join(cacheRoot, `${cacheId}.json`);
}
function readCache(cacheFile) {
    if (!fs.existsSync(cacheFile))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    }
    catch {
        return undefined;
    }
}
function writeCache(cacheFile, payload) {
    fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2));
}
function getMemoryCacheKey(targetDir, options) {
    return options.cacheKey ?? path.resolve(targetDir);
}
function invalidateIndexCache(targetDir, options = {}) {
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
function getIndexCacheStats(targetDir, options = {}) {
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
function buildIndex(targetDir) {
    return buildIndexWithCache(targetDir, { useCache: false }).index;
}
function buildIndexWithCache(targetDir, options = {}) {
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
    if (inMemory &&
        inMemory.version === INDEX_CACHE_VERSION &&
        inMemory.targetDir === resolvedTargetDir &&
        inMemory.fingerprint === fingerprint) {
        return {
            index: inMemory.index,
            cache: { enabled: true, hit: true, cacheFile, fingerprint, layer: "memory" },
        };
    }
    const cached = options.forceRefresh ? undefined : readCache(cacheFile);
    if (cached &&
        cached.version === INDEX_CACHE_VERSION &&
        cached.targetDir === resolvedTargetDir &&
        cached.fingerprint === fingerprint) {
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
function formatIndexForPrompt(index) {
    const lines = [];
    for (const [filePath, entry] of Object.entries(index)) {
        const pkg = entry.packageName ? ` [${entry.packageName}]` : "";
        lines.push(`\n"${filePath}"${pkg} (${entry.sizeKb}kb)`);
        for (const sig of entry.exports) {
            let line = "";
            if (sig.kind === "function") {
                line = `  ${sig.name}(${sig.params}): ${sig.returnType}`;
            }
            else if (sig.kind === "interface") {
                line = `  interface ${sig.name} { ${sig.params} }`;
            }
            else if (sig.kind === "class") {
                line = `  class ${sig.name} — methods: ${sig.params}`;
            }
            else if (sig.kind === "type") {
                line = `  type ${sig.name} = ${sig.params}`;
            }
            else if (sig.kind === "enum") {
                line = `  enum ${sig.name} { ${sig.params} }`;
            }
            if (sig.docstring)
                line += `  // ${sig.docstring}`;
            lines.push(line);
        }
    }
    return lines.join("\n");
}
function countNaiveTokens(targetDir) {
    let total = 0;
    function walk(dir) {
        if (!fs.existsSync(dir))
            return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git")
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
                try {
                    const content = fs.readFileSync(full, "utf-8");
                    total += Math.round(content.length / 4);
                }
                catch { }
            }
        }
    }
    walk(targetDir);
    return total;
}
