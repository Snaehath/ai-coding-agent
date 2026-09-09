import { type McpToolSchema } from "./mcp-client.ts";
export { type McpToolSchema };

export interface ToolCatalogItem {
  name: string;
  category: "filesystem" | "terminal" | "introspection" | "navigation" | "web" | "database" | "mcp" | "specialized";
  description: string;
  schema: any;
  isCore: boolean; // If true, always active in initial context
}

// Global registry of all available tools
class ToolRegistry {
  private catalog: Map<string, ToolCatalogItem> = new Map();
  private activeTools: Set<string> = new Set();

  constructor() {
    this.resetActiveTools();
  }

  // Register a tool definition into catalog
  register(item: ToolCatalogItem): void {
    this.catalog.set(item.name, item);
    if (item.isCore) {
      this.activeTools.add(item.name);
    }
  }

  // Register batch MCP tools
  registerMcpTools(mcpTools: McpToolSchema[]): void {
    for (const t of mcpTools) {
      const isDb = /postgres|database|sql|db/i.test(t.function.name);
      this.catalog.set(t.function.name, {
        name: t.function.name,
        category: isDb ? "database" : "mcp",
        description: t.function.description ?? "MCP external tool",
        schema: t,
        isCore: false, // Discovered on-demand or activated via ToolSearch
      });
    }
  }

  // Reset active tools to only core tools
  resetActiveTools(): void {
    this.activeTools.clear();
    for (const [name, item] of this.catalog.entries()) {
      if (item.isCore) this.activeTools.add(name);
    }
  }

  // Activate a specific tool for the current session
  activateTool(name: string): boolean {
    if (this.catalog.has(name)) {
      this.activeTools.add(name);
      return true;
    }
    return false;
  }

  // Adaptive Semantic Tool Router: Automatically activates on-demand tools based on user intent & context
  autoRoute(textContext: string, isDbActive: boolean = false): string[] {
    const activated: string[] = [];
    const text = textContext.toLowerCase();

    const rules: Array<{ pattern: RegExp; tools: string[]; requireDb?: boolean }> = [
      {
        pattern: /\b(find files?|locate|search files?|list files?|tree|directory structure|where is)\b/i,
        tools: ["Find", "Tree"],
      },
      {
        pattern: /\b(grep|search code|search text|find occurrences?|look for text|search pattern)\b/i,
        tools: ["Grep"],
      },
      {
        pattern: /\b(inspect|vram|hardware|system specs|sysinfo|specs|processes|inspect project)\b/i,
        tools: ["Inspect"],
      },
      {
        pattern: /\b(weather|forecast|temperature|celsius|fahrenheit|humidity|wind|climate|chennai|london|tokyo)\b/i,
        tools: ["Weather"],
      },
      {
        pattern: /\b(calculate|math|equation|arithmetic|formula|conversion|percentage|convert)\b/i,
        tools: ["Calculator"],
      },
      {
        pattern: /\b(database|sql|postgres|neondb|tables?|schema|rows?|columns?|query|db_)\b/i,
        tools: ["db_query", "db_schema", "db_list_tables", "db_describe_table"],
        requireDb: true,
      },
      {
        pattern: /\b(search online|google|web search|look up on web|search the web|browse online|latest docs?)\b/i,
        tools: ["WebSearch"],
      },
      {
        pattern: /\b(dead code|unused exports?|orphan|entropy|clean up unused|scan dependencies)\b/i,
        tools: ["DeadCodeScan"],
      },
      {
        pattern: /\b(root cause|failure chain|why is it slow|causal|troubleshoot degradation)\b/i,
        tools: ["CausalAnalyze"],
      },
      {
        pattern: /\b(extract symbols?|function signatures?|outline file|classes and types)\b/i,
        tools: ["ExtractSymbols", "SummarizeFile"],
      },
      {
        pattern: /\b(definition of|find callers?|references to|lsp hover|symbol hover)\b/i,
        tools: ["LSP_Definition", "LSP_References", "LSP_Hover"],
      },
      {
        pattern: /\b(summarize diff|git diff changes|review diff)\b/i,
        tools: ["SummarizeDiff"],
      },
    ];

    for (const rule of rules) {
      if (rule.requireDb && !isDbActive) continue;
      if (rule.pattern.test(text)) {
        for (const t of rule.tools) {
          if (this.activateTool(t)) {
            activated.push(t);
          }
        }
      }
    }

    return activated;
  }

  // Get currently active tool schemas for LLM payload
  getActiveSchemas(): any[] {
    const schemas: any[] = [];
    for (const name of this.activeTools) {
      const item = this.catalog.get(name);
      if (item) schemas.push(item.schema);
    }
    return schemas;
  }

  // Search available tools by keyword or category
  search(query: string, category?: string): { results: ToolCatalogItem[]; activated: string[] } {
    const q = query.toLowerCase().trim();
    const results: ToolCatalogItem[] = [];
    const activated: string[] = [];

    for (const item of this.catalog.values()) {
      if (category && item.category !== category.toLowerCase()) continue;

      const matches =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q);

      if (matches) {
        results.push(item);
        // Automatically activate matching tool into context
        this.activeTools.add(item.name);
        activated.push(item.name);
      }
    }

    return { results, activated };
  }

  // List all available tools grouped by category
  listAvailable(categoryFilter?: string): Record<string, Array<{ name: string; description: string; active: boolean }>> {
    const grouped: Record<string, Array<{ name: string; description: string; active: boolean }>> = {};

    for (const item of this.catalog.values()) {
      if (categoryFilter && item.category !== categoryFilter.toLowerCase()) continue;

      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push({
        name: item.name,
        description: item.description,
        active: this.activeTools.has(item.name),
      });
    }

    return grouped;
  }
}

export const toolRegistry = new ToolRegistry();

// Tool execution handlers for on-demand discovery
export function executeToolSearch(query: string, category?: string): string {
  const q = String(query ?? "").trim();
  if (!q || q === "all" || q === "list" || q === "*") {
    return executeToolsAvailable(category);
  }

  const { results, activated } = toolRegistry.search(q, category);

  if (results.length === 0) {
    return `No specialized tools found matching "${q}"${category ? ` in category "${category}"` : ""}.\n\n` + executeToolsAvailable(category);
  }

  const lines = [
    `🔍 Discovered & Activated ${results.length} Tool(s) into context:`,
    ...results.map(
      (r) =>
        `  • [${r.category.toUpperCase()}] ${r.name}: ${r.description.slice(0, 90)}${r.description.length > 90 ? "..." : ""}`,
    ),
    `\n💡 These tools are now loaded and immediately callable in your next action!`,
  ];

  return lines.join("\n");
}

export function executeToolsAvailable(category?: string): string {
  const grouped = toolRegistry.listAvailable(category);
  const lines = [`🧰 Available Tool Catalogs${category ? ` [Category: ${category}]` : ""}:`];

  for (const [cat, tools] of Object.entries(grouped)) {
    lines.push(`\n📁 Category: ${cat.toUpperCase()} (${tools.length} tools)`);
    for (const t of tools) {
      const status = t.active ? "🟢 Active" : "⚪ On-Demand";
      lines.push(`  • ${t.name.padEnd(22)} [${status}] : ${t.description.slice(0, 75)}`);
    }
  }

  lines.push(`\n💡 To activate on-demand tools, invoke ToolSearch with a query or tool name.`);
  return lines.join("\n");
}
