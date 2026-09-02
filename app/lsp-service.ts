import fs from "node:fs";
import path from "node:path";
import {
  LspClient,
  pathToUri,
  uriToPath,
  getSymbolKindName,
  type LspLocation,
  type LspSymbol,
} from "./lsp-client.ts";

// Constants
export const LSP_CONFIG_PATH = path.resolve(process.cwd(), ".agents", "lsp.json");

// Types
export type LspServerConfig = {
  id: string;
  extensions: string[];
  command: string;
  args?: string[];
};

export type DefinitionResult = {
  filePath: string;
  line: number;
  character: number;
  preview: string;
};

export type ReferenceResult = {
  filePath: string;
  line: number;
  character: number;
  lineContent: string;
};

export type SymbolOutlineItem = {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  preview: string;
};

// Fallback Symbol Extractor using Regex Parser
export function extractStaticDocumentSymbols(filePath: string): SymbolOutlineItem[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const symbols: SymbolOutlineItem[] = [];

  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/, kind: "Function" },
    { regex: /^\s*(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/, kind: "Class" },
    { regex: /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/, kind: "Interface" },
    { regex: /^\s*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/, kind: "Type" },
    { regex: /^\s*(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)/, kind: "Enum" },
    { regex: /^\s*(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*[:=]/, kind: "Constant" },
    { regex: /^\s*(?:export\s+)?let\s+([a-zA-Z0-9_$]+)\s*[:=]/, kind: "Variable" },
    { regex: /^\s*(?:public|private|protected)?\s*(?:async\s+)?([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*[:{]/, kind: "Method" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, kind } of patterns) {
      const match = line.match(regex);
      if (match && match[1]) {
        // Skip common false positives
        if (["if", "for", "while", "switch", "catch"].includes(match[1])) continue;
        symbols.push({
          name: match[1],
          kind,
          line: i + 1,
          endLine: i + 1,
          preview: line.trim(),
        });
        break;
      }
    }
  }

  return symbols;
}

// Fallback Symbol Definition Locator across Workspace
export function findStaticDefinition(
  symbol: string,
  searchRoot: string = process.cwd(),
): DefinitionResult | null {
  const cleanSymbol = symbol.trim();
  const searchDirs = ["app", "src", "lib", "."];

  const defPatterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${cleanSymbol}\\b`),
    new RegExp(`(?:export\\s+)?class\\s+${cleanSymbol}\\b`),
    new RegExp(`(?:export\\s+)?interface\\s+${cleanSymbol}\\b`),
    new RegExp(`(?:export\\s+)?type\\s+${cleanSymbol}\\s*=`),
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${cleanSymbol}\\s*[:=]`),
    new RegExp(`(?:export\\s+)?enum\\s+${cleanSymbol}\\b`),
  ];

  function scanDir(dir: string): string[] {
    const full = path.resolve(searchRoot, dir);
    if (!fs.existsSync(full)) return [];
    const results: string[] = [];
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".agents") continue;
      const sub = path.join(full, e.name);
      if (e.isDirectory()) results.push(...scanDir(sub));
      else if (/\.(ts|tsx|js|jsx|py|rs)$/.test(e.name)) results.push(sub);
    }
    return results;
  }

  const allFiles = scanDir(".");
  for (const file of allFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pat of defPatterns) {
        if (pat.test(lines[i])) {
          const col = lines[i].indexOf(cleanSymbol);
          return {
            filePath: path.relative(searchRoot, file).replace(/\\/g, "/"),
            line: i + 1,
            character: col !== -1 ? col + 1 : 1,
            preview: lines[i].trim(),
          };
        }
      }
    }
  }

  return null;
}

// Fallback References Scanner across Workspace
export function findStaticReferences(
  symbol: string,
  searchRoot: string = process.cwd(),
): ReferenceResult[] {
  const cleanSymbol = symbol.trim();
  const wordRegex = new RegExp(`\\b${cleanSymbol}\\b`);
  const refs: ReferenceResult[] = [];

  function scanDir(dir: string): string[] {
    const full = path.resolve(searchRoot, dir);
    if (!fs.existsSync(full)) return [];
    const results: string[] = [];
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".agents") continue;
      const sub = path.join(full, e.name);
      if (e.isDirectory()) results.push(...scanDir(sub));
      else if (/\.(ts|tsx|js|jsx|py|rs|json)$/.test(e.name)) results.push(sub);
    }
    return results;
  }

  const allFiles = scanDir(".");
  for (const file of allFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (wordRegex.test(lines[i])) {
        const col = lines[i].indexOf(cleanSymbol);
        refs.push({
          filePath: path.relative(searchRoot, file).replace(/\\/g, "/"),
          line: i + 1,
          character: col !== -1 ? col + 1 : 1,
          lineContent: lines[i].trim(),
        });
      }
    }
  }

  return refs;
}

// Language Server Management Service
export class LspService {
  private clients = new Map<string, LspClient>();
  private serverConfigs: LspServerConfig[] = [];
  private openedFiles = new Set<string>();

  constructor() {
    this.loadConfig();
  }

  // Load language server configurations from .agents/lsp.json
  private loadConfig(): void {
    if (fs.existsSync(LSP_CONFIG_PATH)) {
      try {
        const raw = fs.readFileSync(LSP_CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        this.serverConfigs = parsed.servers ?? [];
      } catch (e: any) {
        process.stderr.write(`[LSP Config] Error parsing lsp.json: ${e.message}\n`);
      }
    }
  }

  // Get or initialize LSP client for a given file extension
  private async getClientForFile(filePath: string): Promise<LspClient | null> {
    const ext = path.extname(filePath).toLowerCase();
    const config = this.serverConfigs.find((s) => s.extensions.includes(ext));
    if (!config) return null;

    if (this.clients.has(config.id)) {
      return this.clients.get(config.id)!;
    }

    try {
      const client = new LspClient(config.id, config.command, config.args ?? []);
      await client.connect();
      this.clients.set(config.id, client);
      return client;
    } catch {
      // Fallback to static code intelligence if server binary isn't available
      return null;
    }
  }

  // Notify server of open file
  private async ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
    if (this.openedFiles.has(filePath)) return;
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const uri = pathToUri(filePath);

    client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: path.extname(filePath).replace(".", "") || "typescript",
        version: 1,
        text: content,
      },
    });

    this.openedFiles.add(filePath);
  }

  // Go to Definition
  public async getDefinition(
    filePath: string,
    line: number,
    character: number,
    symbol?: string,
  ): Promise<DefinitionResult[]> {
    const client = await this.getClientForFile(filePath);

    if (client && fs.existsSync(filePath)) {
      try {
        await this.ensureFileOpen(client, filePath);
        const res = await client.sendRequest("textDocument/definition", {
          textDocument: { uri: pathToUri(filePath) },
          position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
        });

        if (res) {
          const locs: LspLocation[] = Array.isArray(res) ? res : [res];
          return locs.map((loc) => {
            const defPath = uriToPath(loc.uri);
            const defLine = (loc.range?.start?.line ?? 0) + 1;
            let preview = "";
            if (fs.existsSync(defPath)) {
              const lines = fs.readFileSync(defPath, "utf-8").split("\n");
              preview = lines[defLine - 1]?.trim() ?? "";
            }
            return {
              filePath: path.relative(process.cwd(), defPath).replace(/\\/g, "/"),
              line: defLine,
              character: (loc.range?.start?.character ?? 0) + 1,
              preview,
            };
          });
        }
      } catch {
        /* fallback to static locator */
      }
    }

    // Static fallback
    if (symbol) {
      const def = findStaticDefinition(symbol);
      return def ? [def] : [];
    }

    return [];
  }

  // Find References
  public async getReferences(
    filePath: string,
    line: number,
    character: number,
    symbol?: string,
  ): Promise<ReferenceResult[]> {
    const client = await this.getClientForFile(filePath);

    if (client && fs.existsSync(filePath)) {
      try {
        await this.ensureFileOpen(client, filePath);
        const res = await client.sendRequest("textDocument/references", {
          textDocument: { uri: pathToUri(filePath) },
          position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
          context: { includeDeclaration: true },
        });

        if (Array.isArray(res) && res.length > 0) {
          return res.map((loc: LspLocation) => {
            const refPath = uriToPath(loc.uri);
            const refLine = (loc.range?.start?.line ?? 0) + 1;
            let lineContent = "";
            if (fs.existsSync(refPath)) {
              const lines = fs.readFileSync(refPath, "utf-8").split("\n");
              lineContent = lines[refLine - 1]?.trim() ?? "";
            }
            return {
              filePath: path.relative(process.cwd(), refPath).replace(/\\/g, "/"),
              line: refLine,
              character: (loc.range?.start?.character ?? 0) + 1,
              lineContent,
            };
          });
        }
      } catch {
        /* fallback to static scanner */
      }
    }

    // Static fallback
    if (symbol) {
      return findStaticReferences(symbol);
    }

    return [];
  }

  // Get Document Symbols (classes, methods, functions, types)
  public async getDocumentSymbols(filePath: string): Promise<SymbolOutlineItem[]> {
    const client = await this.getClientForFile(filePath);

    if (client && fs.existsSync(filePath)) {
      try {
        await this.ensureFileOpen(client, filePath);
        const res = await client.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri: pathToUri(filePath) },
        });

        if (Array.isArray(res) && res.length > 0) {
          const lines = fs.readFileSync(filePath, "utf-8").split("\n");
          const flattenSymbols = (items: any[]): SymbolOutlineItem[] => {
            const out: SymbolOutlineItem[] = [];
            for (const it of items) {
              const startLine = (it.range?.start?.line ?? it.location?.range?.start?.line ?? 0) + 1;
              const endLine = (it.range?.end?.line ?? it.location?.range?.end?.line ?? 0) + 1;
              out.push({
                name: it.name,
                kind: getSymbolKindName(it.kind),
                line: startLine,
                endLine,
                preview: lines[startLine - 1]?.trim() ?? "",
              });
              if (Array.isArray(it.children)) {
                out.push(...flattenSymbols(it.children));
              }
            }
            return out;
          };
          return flattenSymbols(res);
        }
      } catch {
        /* fallback */
      }
    }

    // Static AST fallback
    return extractStaticDocumentSymbols(filePath);
  }

  // Hover Information
  public async getHover(
    filePath: string,
    line: number,
    character: number,
    symbol?: string,
  ): Promise<string> {
    const client = await this.getClientForFile(filePath);

    if (client && fs.existsSync(filePath)) {
      try {
        await this.ensureFileOpen(client, filePath);
        const res = await client.sendRequest("textDocument/hover", {
          textDocument: { uri: pathToUri(filePath) },
          position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
        });

        if (res?.contents) {
          if (typeof res.contents === "string") return res.contents;
          if (Array.isArray(res.contents)) {
            return res.contents.map((c: any) => (typeof c === "string" ? c : c.value)).join("\n");
          }
          if (typeof res.contents === "object" && res.contents.value) {
            return res.contents.value;
          }
        }
      } catch {
        /* fallback */
      }
    }

    // Static fallback: read lines around symbol
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      const targetLine = Math.max(0, line - 1);
      const start = Math.max(0, targetLine - 3);
      const end = Math.min(lines.length, targetLine + 4);
      return `\`\`\`typescript\n${lines.slice(start, end).join("\n")}\n\`\`\``;
    }

    return symbol ? `Symbol: ${symbol}` : "No hover information available.";
  }

  // Cleanup all connected LSP processes
  public closeAll(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }
}

// Global Singleton Instance
export const lspService = new LspService();
