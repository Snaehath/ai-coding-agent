import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { estimateTokens, estimateMessagesTokens } from "./telemetry.ts";

export interface ExtractedSymbol {
  kind: "function" | "class" | "interface" | "type" | "const" | "export";
  name: string;
  signature: string;
  line: number;
}

// 1. Extract Symbol Outline (Classes, functions, interfaces, types) from a code file
export function extractSymbols(filePath: string): string {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`;

    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split(/\r?\n/);
    const symbols: ExtractedSymbol[] = [];

    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/;
    const arrowFuncRegex = /^(?:export\s+)?(?:const|let)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^{=]+))?\s*=>/;
    const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?/;
    const interfaceRegex = /^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+[^{]+)?/;
    const typeRegex = /^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)(?:<[^>]+>)?\s*=\s*([^{;\n]+)/;
    const exportConstRegex = /^export\s+const\s+([a-zA-Z0-9_$]+)(?:\s*:\s*([^=;\n]+))?/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNum = i + 1;

      let m = line.match(functionRegex);
      if (m) {
        symbols.push({ kind: "function", name: m[1], signature: `function ${m[1]}(${m[2]})`, line: lineNum });
        continue;
      }

      m = line.match(arrowFuncRegex);
      if (m) {
        symbols.push({ kind: "function", name: m[1], signature: `const ${m[1]} = (${m[2]})${m[3] ? `: ${m[3].trim()}` : ""}`, line: lineNum });
        continue;
      }

      m = line.match(classRegex);
      if (m) {
        symbols.push({ kind: "class", name: m[1], signature: `class ${m[1]}`, line: lineNum });
        continue;
      }

      m = line.match(interfaceRegex);
      if (m) {
        symbols.push({ kind: "interface", name: m[1], signature: `interface ${m[1]}`, line: lineNum });
        continue;
      }

      m = line.match(typeRegex);
      if (m) {
        symbols.push({ kind: "type", name: m[1], signature: `type ${m[1]} = ${m[2].trim()}`, line: lineNum });
        continue;
      }

      m = line.match(exportConstRegex);
      if (m && !line.includes("=>")) {
        symbols.push({ kind: "const", name: m[1], signature: `export const ${m[1]}${m[2] ? `: ${m[2].trim()}` : ""}`, line: lineNum });
      }
    }

    if (symbols.length === 0) {
      return `File Outline [${path.basename(resolved)}] (${lines.length} lines):\nNo top-level exported functions, classes, or types detected.`;
    }

    const output = [
      `📑 Symbol Outline [${path.basename(resolved)}] (${lines.length} lines, ${symbols.length} symbols):`,
      ...symbols.map((s) => `  • L${String(s.line).padEnd(4)} [${s.kind.padEnd(9)}] ${s.signature}`),
    ];

    return output.join("\n");
  } catch (e: any) {
    return `Error extracting symbols from ${filePath}: ${e.message}`;
  }
}

// 2. Summarize Large File (Extract imports, outline, and structural preview)
export function summarizeFile(filePath: string, maxPreviewLines: number = 30): string {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`;

    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split(/\r?\n/);
    const imports: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("import ") || line.startsWith("require(")) {
        imports.push(line);
      }
    }

    const symbolSummary = extractSymbols(filePath);
    const tokenEst = estimateTokens(content);
    const compressedEst = estimateTokens(symbolSummary);
    const compressionRatio = Math.round((1 - compressedEst / Math.max(1, tokenEst)) * 100);

    return [
      `🗜️ Compressed Summary [${path.basename(resolved)}]`,
      `  • Full File Size           : ${lines.length} lines (~${tokenEst} tokens)`,
      `  • Compressed Representation: ~${compressedEst} tokens (${compressionRatio}% token reduction)`,
      ...(imports.length > 0
        ? [`\n  📦 Key Dependencies (${imports.length}):\n${imports.slice(0, 6).map((i) => `    ${i}`).join("\n")}`]
        : []),
      `\n  ${symbolSummary}`,
    ].join("\n");
  } catch (e: any) {
    return `Error summarizing file ${filePath}: ${e.message}`;
  }
}

// 3. Extract Targeted Context Window (Around a symbol, function, or keyword)
export function contextExtract(filePath: string, queryOrLine: string | number, radius: number = 15): string {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`;

    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split(/\r?\n/);

    let targetLine = -1;

    if (typeof queryOrLine === "number") {
      targetLine = Math.max(1, Math.min(lines.length, queryOrLine));
    } else {
      const q = queryOrLine.toLowerCase().trim();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          targetLine = i + 1;
          break;
        }
      }
    }

    if (targetLine === -1) {
      return `Context query "${queryOrLine}" not found in ${filePath} (${lines.length} lines).`;
    }

    const startLine = Math.max(1, targetLine - radius);
    const endLine = Math.min(lines.length, targetLine + radius);

    const slice = lines.slice(startLine - 1, endLine);
    const formatted = slice.map((l, idx) => {
      const current = startLine + idx;
      const marker = current === targetLine ? " ▶ " : "   ";
      return `${marker}${String(current).padStart(4)}: ${l}`;
    });

    return [
      `🎯 Context Window [${path.basename(resolved)}: lines ${startLine}-${endLine} of ${lines.length}] (target: ${queryOrLine})`,
      ...formatted,
    ].join("\n");
  } catch (e: any) {
    return `Error extracting context from ${filePath}: ${e.message}`;
  }
}

// 4. Summarize Git Diff / Changes
export function summarizeDiff(filePathOrRef?: string): string {
  try {
    const target = filePathOrRef ? ` ${filePathOrRef}` : "";
    const diffStat = execSync(`git diff --stat${target}`, { stdio: "pipe" }).toString().trim();
    const diffSummary = execSync(`git diff --compact-summary${target}`, { stdio: "pipe" }).toString().trim();

    if (!diffStat && !diffSummary) {
      return "No uncommitted changes detected in repository or specified target.";
    }

    return [
      `📊 Git Diff Summary:`,
      `  • Summary Changes:`,
      ...diffSummary.split("\n").map((l) => `    ${l}`),
      `\n  • Stat:`,
      ...diffStat.split("\n").map((l) => `    ${l}`),
    ].join("\n");
  } catch (e: any) {
    return `Error summarizing git diff: ${e.message}`;
  }
}

// 5. Intelligent History Compaction for Low-Memory / Low-VRAM Contexts
export function compressHistory(messages: any[], maxTokens: number = 8000): { messages: any[]; compacted: boolean } {
  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= maxTokens || messages.length <= 4) {
    return { messages, compacted: false };
  }

  // Preserve system prompt (first message) and last 3 turns
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  const recentMessages = messages.slice(-4);
  const olderMessages = systemMsg ? messages.slice(1, -4) : messages.slice(0, -4);

  // Digest older messages
  const summaryPoints: string[] = [];
  for (const m of olderMessages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      summaryPoints.push(`User asked: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);
    } else if (m.role === "tool") {
      const text = String(m.content || "");
      summaryPoints.push(`Tool result: ${text.slice(0, 80)}...`);
    } else if (m.role === "assistant" && m.content) {
      const text = String(m.content);
      summaryPoints.push(`Assistant: ${text.slice(0, 100)}...`);
    }
  }

  const compactedSummaryMsg = {
    role: "user",
    content: `[Context Compressed Digest of Prior Turns (${olderMessages.length} turns compacted)]:\n` +
      summaryPoints.slice(-10).map((p) => `• ${p}`).join("\n"),
  };

  const compactedMessages = [
    ...(systemMsg ? [systemMsg] : []),
    compactedSummaryMsg,
    { role: "assistant", content: "Understood. Prior context noted." },
    ...recentMessages,
  ];

  return { messages: compactedMessages, compacted: true };
}
