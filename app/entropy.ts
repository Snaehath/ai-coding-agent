import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORED_DIRS, BINARY_EXTENSIONS } from "./filesystem-tools.ts";

export interface EntropyReport {
  overallEntropyPercent: number;
  totalSourceFiles: number;
  totalCodeLines: number;
  unusedDependencies: string[];
  trulyDeadCode: DeadSymbol[];
  unusedExports: DeadSymbol[];
  orphanFiles: string[];
  staleEnvVars: string[];
  actionableCleanups: string[];
}

// Helper: Recursively collect all source files
function collectProjectFiles(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collectProjectFiles(fullPath, fileList);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!BINARY_EXTENSIONS.has(ext)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

// 1. Scan for Unused Dependencies in package.json
export function scanUnusedDependencies(projectRoot: string = process.cwd()): string[] {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  let pkg: any = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return [];
  }

  const declaredDeps = Object.keys(pkg.dependencies || {});
  if (declaredDeps.length === 0) return [];

  const sourceFiles = collectProjectFiles(projectRoot).filter((f) =>
    /\.(ts|js|tsx|jsx|mjs|cjs)$/i.test(f),
  );

  let combinedCode = "";
  for (const f of sourceFiles) {
    if (f.endsWith("package.json") || f.includes("node_modules")) continue;
    try {
      combinedCode += fs.readFileSync(f, "utf-8") + "\n";
    } catch {
      /* ignore */
    }
  }

  const unused: string[] = [];
  for (const dep of declaredDeps) {
    // Check for standard import or require
    const depRegex = new RegExp(`['"]${dep}(?:/[^'"]*)?['"]`, "i");
    if (!depRegex.test(combinedCode)) {
      unused.push(dep);
    }
  }

  return unused;
}

// 2. Scan for Dead / Orphan Exports
export interface DeadSymbol {
  file: string;
  symbol: string;
  line: number;
  type: "dead_code" | "unused_export";
  reason: string;
}

// 2. Scan for Truly Dead Code vs Unnecessary Public Exports
export function scanDeadExports(projectRoot: string = process.cwd()): DeadSymbol[] {
  const sourceFiles = collectProjectFiles(projectRoot).filter((f) =>
    /\.(ts|js|tsx|jsx)$/i.test(f) && !f.includes(".test.") && !f.includes(".spec."),
  );

  const fileContents = new Map<string, string>();
  let allProjectText = "";

  for (const f of sourceFiles) {
    try {
      const text = fs.readFileSync(f, "utf-8");
      fileContents.set(f, text);
      allProjectText += text + "\n";
    } catch {
      /* ignore */
    }
  }

  const deadSymbols: DeadSymbol[] = [];
  const exportRegex = /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+([a-zA-Z0-9_$]+)/;

  for (const [filePath, content] of fileContents.entries()) {
    const base = path.basename(filePath);
    // Skip CLI and server top-level roots
    if (["main.ts", "index.ts", "server.ts"].includes(base)) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = line.match(exportRegex);
      if (m) {
        const symbol = m[1];
        const symbolRegex = new RegExp(`\\b${symbol}\\b`, "g");
        const totalMatches = (allProjectText.match(symbolRegex) || []).length;
        const selfMatches = (content.match(symbolRegex) || []).length;

        if (totalMatches <= 1) {
          // Truly dead: defined once and never referenced anywhere
          deadSymbols.push({
            file: path.relative(projectRoot, filePath),
            symbol,
            line: i + 1,
            type: "dead_code",
            reason: "Symbol defined but never referenced anywhere in the project (safe to remove)",
          });
        } else if (totalMatches === selfMatches) {
          // Unused export: used internally in this file, but no external files import it
          deadSymbols.push({
            file: path.relative(projectRoot, filePath),
            symbol,
            line: i + 1,
            type: "unused_export",
            reason: "Used only internally within this file (can remove 'export' modifier to keep API clean)",
          });
        }
      }
    }
  }

  return deadSymbols;
}

// 3. Scan for Orphaned Source Files (0 incoming imports)
export function scanOrphanFiles(projectRoot: string = process.cwd()): string[] {
  const sourceFiles = collectProjectFiles(projectRoot).filter((f) =>
    /\.(ts|js|tsx|jsx)$/i.test(f) &&
    !f.includes(".test.") &&
    !f.includes(".agents") &&
    !f.includes("scripts"),
  );

  let allImportsText = "";
  for (const f of sourceFiles) {
    try {
      allImportsText += fs.readFileSync(f, "utf-8") + "\n";
    } catch {
      /* ignore */
    }
  }

  const orphanFiles: string[] = [];
  const entryFiles = new Set(["main.ts", "index.ts", "server.ts", "app.ts", "agent.ts"]);

  for (const f of sourceFiles) {
    const baseName = path.basename(f);
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, "");

    if (entryFiles.has(baseName)) continue;

    const importRegex = new RegExp(`['"][^'"]*\\b${nameWithoutExt}(?:\\.[^'"]*)?['"]`, "i");
    if (!importRegex.test(allImportsText)) {
      orphanFiles.push(path.relative(projectRoot, f));
    }
  }

  return orphanFiles;
}

// 4. Scan for Stale Environment Variables
export function scanStaleEnvVars(projectRoot: string = process.cwd()): string[] {
  const envExamplePath = [
    path.join(projectRoot, ".env.example"),
    path.join(projectRoot, ".env.sample"),
    path.join(projectRoot, ".env"),
  ].find((p) => fs.existsSync(p));

  if (!envExamplePath) return [];

  const envContent = fs.readFileSync(envExamplePath, "utf-8");
  const envKeys = envContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.split("=")[0].trim());

  const sourceFiles = collectProjectFiles(projectRoot).filter((f) =>
    /\.(ts|js|tsx|jsx|json)$/i.test(f),
  );

  let allCode = "";
  for (const f of sourceFiles) {
    try {
      allCode += fs.readFileSync(f, "utf-8") + "\n";
    } catch {
      /* ignore */
    }
  }

  const stale: string[] = [];
  for (const key of envKeys) {
    if (!allCode.includes(key)) {
      stale.push(key);
    }
  }

  return stale;
}

// 5. Compute Full Project Entropy & Dead Code Report
export function computeProjectEntropy(projectRoot: string = process.cwd()): EntropyReport {
  const sourceFiles = collectProjectFiles(projectRoot).filter((f) =>
    /\.(ts|js|tsx|jsx|py|rs|go|json|css|html|md)$/i.test(f),
  );

  let totalLines = 0;
  for (const f of sourceFiles) {
    try {
      totalLines += fs.readFileSync(f, "utf-8").split(/\r?\n/).length;
    } catch {
      /* ignore */
    }
  }

  const unusedDeps = scanUnusedDependencies(projectRoot);
  const deadSymbols = scanDeadExports(projectRoot);
  const orphanFiles = scanOrphanFiles(projectRoot);
  const staleEnv = scanStaleEnvVars(projectRoot);

  const trulyDead = deadSymbols.filter((s) => s.type === "dead_code");
  const unusedExports = deadSymbols.filter((s) => s.type === "unused_export");

  // Compute weighted entropy penalty
  const deadItemsCount =
    unusedDeps.length * 4 +
    trulyDead.length * 2 +
    unusedExports.length * 0.5 +
    orphanFiles.length * 3 +
    staleEnv.length * 2;

  const totalPoints = Math.max(20, sourceFiles.length * 4);
  const entropyPercent = Math.min(100, Math.round((deadItemsCount / totalPoints) * 100));

  const cleanups: string[] = [];
  if (unusedDeps.length > 0) cleanups.push(`Remove ${unusedDeps.length} unused package(s): ${unusedDeps.join(", ")}`);
  if (trulyDead.length > 0) cleanups.push(`Delete ${trulyDead.length} truly dead symbol(s) never referenced anywhere`);
  if (unusedExports.length > 0) cleanups.push(`Drop 'export' modifier from ${unusedExports.length} internal symbol(s) to clean public APIs`);
  if (orphanFiles.length > 0) cleanups.push(`Delete or wire ${orphanFiles.length} orphan file(s): ${orphanFiles.slice(0, 3).join(", ")}`);
  if (staleEnv.length > 0) cleanups.push(`Clean ${staleEnv.length} stale env var(s): ${staleEnv.join(", ")}`);

  return {
    overallEntropyPercent: entropyPercent,
    totalSourceFiles: sourceFiles.length,
    totalCodeLines: totalLines,
    unusedDependencies: unusedDeps,
    trulyDeadCode: trulyDead,
    unusedExports,
    orphanFiles,
    staleEnvVars: staleEnv,
    actionableCleanups: cleanups,
  };
}

// 6. Format Terminal Report
export function renderEntropyReport(projectRoot: string = process.cwd()): string {
  const report = computeProjectEntropy(projectRoot);

  const statusBadge =
    report.overallEntropyPercent <= 10
      ? "🟢 Clean (Low Entropy)"
      : report.overallEntropyPercent <= 25
        ? "🟡 Moderate (Pruning Opportunities)"
        : "🔴 High Entropy (Significant Dead Code)";

  const lines = [
    `🧹 Project Entropy & Dead Code Garbage Collector:`,
    `  • Overall Project Entropy  : ${report.overallEntropyPercent}% [${statusBadge}]`,
    `  • Total Project Scope      : ${report.totalSourceFiles} source files (${report.totalCodeLines.toLocaleString()} lines of code)`,
    `  • Unused Dependencies      : ${report.unusedDependencies.length > 0 ? `${report.unusedDependencies.length} (${report.unusedDependencies.join(", ")})` : "0 (All active)"}`,
    `  • Truly Dead Code          : ${report.trulyDeadCode.length} symbol(s) never referenced (safe to delete)`,
    `  • Unused Public Exports    : ${report.unusedExports.length} symbol(s) used internally (drop 'export' keyword)`,
    `  • Orphaned Source Files    : ${report.orphanFiles.length > 0 ? `${report.orphanFiles.length} (${report.orphanFiles.join(", ")})` : "0 (None)"}`,
    `  • Stale Env Variables      : ${report.staleEnvVars.length > 0 ? `${report.staleEnvVars.length} (${report.staleEnvVars.join(", ")})` : "0 (None)"}`,
  ];

  if (report.trulyDeadCode.length > 0) {
    lines.push(`\n🗑️ Truly Dead Code (0 references anywhere):`);
    for (const d of report.trulyDeadCode.slice(0, 6)) {
      lines.push(`  • ${d.file}:L${d.line} -> ${d.symbol}`);
    }
  }

  if (report.unusedExports.length > 0) {
    lines.push(`\n🔒 Unnecessary 'export' Modifiers (Used internally only):`);
    for (const d of report.unusedExports.slice(0, 6)) {
      lines.push(`  • ${d.file}:L${d.line} -> export ${d.symbol}`);
    }
  }

  if (report.actionableCleanups.length > 0) {
    lines.push(`\n💡 Recommended Pruning & Cleanup Actions:`);
    for (const act of report.actionableCleanups) {
      lines.push(`  • ${act}`);
    }
  } else {
    lines.push(`\n✨ Codebase is lean and fully pruned! No garbage detected.`);
  }

  return lines.join("\n");
}
