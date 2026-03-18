import { Project, SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

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

export function buildIndex(targetDir: string): RepoIndex {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, skipLibCheck: true },
  });

  // Collect all .ts files (skip .d.ts, node_modules, dist, test files)
  const tsFiles: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
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

  project.addSourceFilesAtPaths(tsFiles);

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