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
exports.clearReadFileCache = clearReadFileCache;
exports.getReadFileCacheStats = getReadFileCacheStats;
exports.readFile = readFile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ts_morph_1 = require("ts-morph");
const CacheManager_1 = require("./CacheManager");
const rawFileCache = new CacheManager_1.CacheManager({ maxEntries: 500, ttlMs: 5 * 60_000 });
const symbolsCache = new CacheManager_1.CacheManager({ maxEntries: 300, ttlMs: 10 * 60_000 });
function clearReadFileCache() {
    rawFileCache.clear();
    symbolsCache.clear();
}
function getReadFileCacheStats() {
    return {
        raw: rawFileCache.stats(),
        symbols: symbolsCache.stats(),
    };
}
function loadRawSnapshot(filePath, useCache) {
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
    const snapshot = {
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
function readFile(filePath, options = {}) {
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
        const project = new ts_morph_1.Project({ skipAddingFilesFromTsConfig: true });
        const sf = project.addSourceFileAtPath(filePath);
        const lines = [`// symbols-only mode: ${path.basename(filePath)}`];
        for (const fn of sf.getFunctions()) {
            if (!fn.isExported())
                continue;
            const params = fn.getParameters().map(p => `${p.getName()}: ${p.getType().getText()}`).join(", ");
            lines.push(`export function ${fn.getName()}(${params}): ${fn.getReturnType().getText()}`);
        }
        for (const iface of sf.getInterfaces()) {
            if (!iface.isExported())
                continue;
            const props = iface.getProperties()
                .map(p => `  ${p.getName()}${p.hasQuestionToken() ? "?" : ""}: ${p.getType().getText()}`)
                .join(";\n");
            lines.push(`export interface ${iface.getName()} {\n${props}\n}`);
        }
        for (const ta of sf.getTypeAliases()) {
            if (!ta.isExported())
                continue;
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
