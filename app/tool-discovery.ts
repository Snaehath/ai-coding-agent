import { type McpToolSchema } from "./mcp.ts";

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
      this.catalog.set(t.function.name, {
        name: t.function.name,
        category: "mcp",
        description: t.function.description ?? "MCP external tool",
        schema: t,
        isCore: false, // MCP tools discovered on-demand to save context
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
  const { results, activated } = toolRegistry.search(query, category);

  if (results.length === 0) {
    return `No specialized tools found matching "${query}"${category ? ` in category "${category}"` : ""}.\nUse ToolsAvailable to see all categories.`;
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
