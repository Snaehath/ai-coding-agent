import fs from "node:fs";
import path from "node:path";

// Standard directories & files to ignore across all search operations
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".next",
  "coverage",
  ".agents/sessions",
  ".agents/telemetry",
  ".gemini",
  ".turbo",
]);

// Binary file extensions to skip during text content inspection
export const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".mp3", ".mp4", ".mov", ".avi", ".wav",
  ".ttf", ".otf", ".woff", ".woff2",
]);

// Helper to check if a directory or file should be ignored
function isIgnored(itemPath: string, rootDir: string): boolean {
  const rel = path.relative(rootDir, itemPath).replace(/\\/g, "/");
  const segments = rel.split("/");

  for (const seg of segments) {
    if (DEFAULT_IGNORED_DIRS.has(seg)) return true;
  }
  return false;
}

// Convert a simple glob pattern (e.g. "src/**/*.ts", "*.json", "app/*.ts") to RegExp
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").trim();
  let regexStr = "";

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*" && normalized[i + 1] === "*") {
      // Globstar **
      if (normalized[i + 2] === "/") {
        regexStr += "(?:.*/)?";
        i += 2;
      } else {
        regexStr += ".*";
        i++;
      }
    } else if (char === "*") {
      regexStr += "[^/]*";
    } else if (char === "?") {
      regexStr += "[^/]";
    } else if (["[", "]", "(", ")", "{", "}", "+", ".", "^", "$", "|"].includes(char)) {
      regexStr += `\\${char}`;
    } else {
      regexStr += char;
    }
  }

  return new RegExp(`^${regexStr}$`, "i");
}

// 1. Glob: Find files matching a glob pattern
export function executeGlob(
  pattern: string,
  targetDir: string = process.cwd(),
  maxResults: number = 100,
): string {
  try {
    const root = path.resolve(process.cwd(), targetDir);
    if (!fs.existsSync(root)) {
      return `Error: directory not found: ${targetDir}`;
    }

    const cleanPattern = pattern.trim().replace(/^['"]|['"]$/g, "");
    const matcher = globToRegExp(cleanPattern);
    const matches: string[] = [];

    function walk(dir: string) {
      if (matches.length >= maxResults) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        const fullPath = path.join(dir, entry.name);
        if (isIgnored(fullPath, root)) continue;

        const relPath = path.relative(root, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          if (matcher.test(relPath) || matcher.test(entry.name)) {
            matches.push(relPath);
          }
        }
      }
    }

    walk(root);

    if (matches.length === 0) {
      return `No files matching "${pattern}" in ${path.relative(process.cwd(), root) || "."}.`;
    }

    const countHeader =
      matches.length >= maxResults
        ? `Matched ${matches.length} files (capped at ${maxResults}):\n`
        : `Matched ${matches.length} file(s):\n`;

    return countHeader + matches.map((m) => `  • ${m}`).join("\n");
  } catch (e: any) {
    return `Error executing glob "${pattern}": ${e.message}`;
  }
}

// 2. Grep: Search for text or regex across files
export function executeGrep(
  query: string,
  searchPath: string = ".",
  includePattern?: string,
  maxMatches: number = 80,
): string {
  try {
    const root = path.resolve(process.cwd(), searchPath);
    if (!fs.existsSync(root)) {
      return `Error: path not found: ${searchPath}`;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }

    const includeMatcher = includePattern
      ? globToRegExp(includePattern.trim().replace(/^['"]|['"]$/g, ""))
      : null;

    const results: Array<{ file: string; line: number; text: string }> = [];

    function searchFile(filePath: string) {
      if (results.length >= maxMatches) return;
      const ext = path.extname(filePath).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) return;

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const rel = path.relative(process.cwd(), filePath).replace(/\\/g, "/");

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxMatches) break;
          const line = lines[i];
          if (regex.test(line)) {
            results.push({
              file: rel,
              line: i + 1,
              text: line.trim().slice(0, 200),
            });
          }
        }
      } catch {
        /* skip unreadable */
      }
    }

    function walk(dir: string) {
      if (results.length >= maxMatches) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxMatches) return;
        const fullPath = path.join(dir, entry.name);
        if (isIgnored(fullPath, root)) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const rel = path.relative(root, fullPath).replace(/\\/g, "/");
          if (!includeMatcher || includeMatcher.test(rel) || includeMatcher.test(entry.name)) {
            searchFile(fullPath);
          }
        }
      }
    }

    const stat = fs.statSync(root);
    if (stat.isDirectory()) {
      walk(root);
    } else {
      searchFile(root);
    }

    if (results.length === 0) {
      return `No matches found for "${query}" in ${path.relative(process.cwd(), root) || "."}.`;
    }

    const countHeader =
      results.length >= maxMatches
        ? `Found ${results.length} matches (capped at ${maxMatches}):\n`
        : `Found ${results.length} match(es):\n`;

    return (
      countHeader +
      results.map((r) => `  ${r.file}:${r.line}: ${r.text}`).join("\n")
    );
  } catch (e: any) {
    return `Error executing grep for "${query}": ${e.message}`;
  }
}

// 3. Find: Fast file locator by exact name or substring
export function executeFind(
  name: string,
  targetDir: string = ".",
  maxResults: number = 60,
): string {
  try {
    const root = path.resolve(process.cwd(), targetDir);
    if (!fs.existsSync(root)) {
      return `Error: directory not found: ${targetDir}`;
    }

    const cleanName = name.trim().toLowerCase().replace(/^['"]|['"]$/g, "");
    const matches: string[] = [];

    function walk(dir: string) {
      if (matches.length >= maxResults) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        const fullPath = path.join(dir, entry.name);
        if (isIgnored(fullPath, root)) continue;

        const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
        if (entry.name.toLowerCase().includes(cleanName)) {
          matches.push(rel + (entry.isDirectory() ? "/" : ""));
        }

        if (entry.isDirectory()) {
          walk(fullPath);
        }
      }
    }

    walk(root);

    if (matches.length === 0) {
      return `No files or directories found matching "${name}".`;
    }

    return (
      `Found ${matches.length} item(s) matching "${name}":\n` +
      matches.map((m) => `  • ${m}`).join("\n")
    );
  } catch (e: any) {
    return `Error executing find "${name}": ${e.message}`;
  }
}

// 4. Tree: Visual directory tree generator
export function executeTree(
  targetDir: string = ".",
  maxDepth: number = 3,
  maxEntries: number = 100,
): string {
  try {
    const root = path.resolve(process.cwd(), targetDir);
    if (!fs.existsSync(root)) {
      return `Error: directory not found: ${targetDir}`;
    }

    let count = 0;
    const lines: string[] = [path.basename(root) || "."];

    function buildTree(dir: string, prefix: string, currentDepth: number) {
      if (currentDepth > maxDepth || count >= maxEntries) return;

      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => !isIgnored(path.join(dir, e.name), root))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (let i = 0; i < entries.length; i++) {
        if (count >= maxEntries) {
          lines.push(`${prefix}... (capped at ${maxEntries} entries)`);
          return;
        }

        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const pointer = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";
        const fullPath = path.join(dir, entry.name);

        count++;
        lines.push(`${prefix}${pointer}${entry.name}${entry.isDirectory() ? "/" : ""}`);

        if (entry.isDirectory()) {
          buildTree(fullPath, prefix + childPrefix, currentDepth + 1);
        }
      }
    }

    buildTree(root, "", 1);
    return lines.join("\n");
  } catch (e: any) {
    return `Error generating tree for "${targetDir}": ${e.message}`;
  }
}

// Syntax validation helper to prevent code corruption
export function validateCodeSyntax(filePath: string, content: string): { valid: boolean; error?: string } {
  const ext = path.extname(filePath).toLowerCase();

  // 1. JSON validation
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: `Invalid JSON syntax: ${e.message}` };
    }
  }

  // 2. TypeScript / JavaScript syntax validation using Bun's native Transpiler
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    try {
      if (typeof Bun !== "undefined" && (Bun as any).Transpiler) {
        const transpiler = new (Bun as any).Transpiler({
          loader: ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : ext.startsWith(".t") ? "ts" : "js",
        });
        transpiler.transformSync(content);
      }
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: `Syntax error in ${path.basename(filePath)}: ${e.message}` };
    }
  }

  // 3. Basic bracket balancing for other code files
  if ([".py", ".rs", ".go", ".c", ".cpp", ".java"].includes(ext)) {
    const stack: string[] = [];
    const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
    let inString: string | null = null;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== "\\")) {
        if (!inString) inString = char;
        else if (inString === char) inString = null;
        continue;
      }
      if (inString) continue;

      if (char === "(" || char === "{" || char === "[") {
        stack.push(char);
      } else if (char === ")" || char === "}" || char === "]") {
        const top = stack.pop();
        if (!top || pairs[top] !== char) {
          return { valid: false, error: `Unmatched bracket '${char}' detected around character ${i}.` };
        }
      }
    }
    if (stack.length > 0) {
      return { valid: false, error: `Unclosed bracket '${stack.pop()}' detected.` };
    }
  }

  return { valid: true };
}

export interface EditParams {
  filePath: string;
  operation?: "replace" | "insert_after" | "insert_before" | "delete" | "append" | "prepend";
  oldString?: string;
  newString?: string;
  anchor?: string;
  content?: string;
  replaceAll?: boolean;
  validateAst?: boolean;
}

// 5. Edit: First-class structural file editor
export function executeEdit(
  rawFilePath: string,
  rawOldOrParams: string | EditParams,
  rawNewOrAnchor?: string,
  rawReplaceAllOrContent?: boolean | string,
): string {
  try {
    let params: EditParams;

    if (typeof rawOldOrParams === "object" && rawOldOrParams !== null) {
      params = {
        filePath: (rawOldOrParams as any).file_path || (rawOldOrParams as any).file || rawFilePath,
        operation: (rawOldOrParams as any).operation || "replace",
        oldString: (rawOldOrParams as any).old_string || (rawOldOrParams as any).old || (rawOldOrParams as any).target,
        newString: (rawOldOrParams as any).new_string || (rawOldOrParams as any).new || (rawOldOrParams as any).content,
        anchor: (rawOldOrParams as any).anchor || (rawOldOrParams as any).target,
        content: (rawOldOrParams as any).content || (rawOldOrParams as any).new_string || (rawOldOrParams as any).new,
        replaceAll: Boolean((rawOldOrParams as any).replace_all || (rawOldOrParams as any).replaceAll),
        validateAst: (rawOldOrParams as any).validate_ast !== false,
      };
    } else {
      params = {
        filePath: rawFilePath,
        operation: "replace",
        oldString: String(rawOldOrParams ?? ""),
        newString: String(rawNewOrAnchor ?? ""),
        content: String(rawNewOrAnchor ?? ""),
        replaceAll: Boolean(rawReplaceAllOrContent),
        validateAst: true,
      };
    }

    const resolved = path.resolve(process.cwd(), params.filePath);
    if (!fs.existsSync(resolved)) {
      return `Error: file not found: ${params.filePath}`;
    }

    const currentContent = fs.readFileSync(resolved, "utf-8");
    const op = params.operation || "replace";
    let updatedContent = currentContent;

    // Operation 1: Insert After
    if (op === "insert_after") {
      const anchor = params.anchor || params.oldString;
      const toInsert = params.content || params.newString || "";
      if (!anchor) return `Error: 'anchor' is required for insert_after operation.`;

      const lines = currentContent.split(/\r?\n/);
      const matchIdx = lines.findIndex((l) => l.includes(anchor));
      if (matchIdx === -1) {
        return `Error: anchor "${anchor}" not found in ${params.filePath}.`;
      }

      // Preserve indentation if applicable
      lines.splice(matchIdx + 1, 0, toInsert);
      updatedContent = lines.join("\n");
    }
    // Operation 2: Insert Before
    else if (op === "insert_before") {
      const anchor = params.anchor || params.oldString;
      const toInsert = params.content || params.newString || "";
      if (!anchor) return `Error: 'anchor' is required for insert_before operation.`;

      const lines = currentContent.split(/\r?\n/);
      const matchIdx = lines.findIndex((l) => l.includes(anchor));
      if (matchIdx === -1) {
        return `Error: anchor "${anchor}" not found in ${params.filePath}.`;
      }

      lines.splice(matchIdx, 0, toInsert);
      updatedContent = lines.join("\n");
    }
    // Operation 3: Delete
    else if (op === "delete") {
      const target = params.oldString || params.anchor;
      if (!target) return `Error: target text or anchor is required for delete operation.`;
      if (!currentContent.includes(target)) {
        return `Error: target text "${target}" not found in ${params.filePath}.`;
      }
      updatedContent = params.replaceAll
        ? currentContent.replaceAll(target, "")
        : currentContent.replace(target, "");
    }
    // Operation 4: Append
    else if (op === "append") {
      const toAppend = params.content || params.newString || "";
      updatedContent = currentContent.endsWith("\n")
        ? currentContent + toAppend + "\n"
        : currentContent + "\n" + toAppend + "\n";
    }
    // Operation 5: Prepend
    else if (op === "prepend") {
      const toPrepend = params.content || params.newString || "";
      updatedContent = toPrepend + "\n" + currentContent;
    }
    // Operation 6: Replace (Default)
    else {
      const oldStr = params.oldString || params.anchor || "";
      const newStr = params.newString ?? params.content ?? "";

      if (!oldStr) {
        return `Error: 'old_string' (or 'old') is required for replace operation.`;
      }

      if (!currentContent.includes(oldStr)) {
        return `Error: old_string not found in ${params.filePath}. Please verify exact characters, indentation, and line breaks.`;
      }

      const occurrences = currentContent.split(oldStr).length - 1;
      if (occurrences > 1 && !params.replaceAll) {
        return `Error: old_string occurred ${occurrences} times in ${params.filePath}. Specify more surrounding context to match a unique block or pass replace_all: true.`;
      }

      updatedContent = params.replaceAll
        ? currentContent.replaceAll(oldStr, newStr)
        : currentContent.replace(oldStr, newStr);
    }

    // AST / Syntax Integrity Validation Guard
    if (params.validateAst !== false) {
      const syntaxCheck = validateCodeSyntax(resolved, updatedContent);
      if (!syntaxCheck.valid) {
        return `Error: Edit aborted — AST syntax validation failed: ${syntaxCheck.error}. The file was NOT modified to prevent code corruption.`;
      }
    }

    fs.writeFileSync(resolved, updatedContent, "utf-8");
    return `Successfully edited ${params.filePath} (operation: ${op}).`;
  } catch (e: any) {
    return `Error editing ${rawFilePath}: ${e.message}`;
  }
}
