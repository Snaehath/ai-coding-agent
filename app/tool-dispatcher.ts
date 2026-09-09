import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import type OpenAI from "openai";

import {
  executeEdit,
  executeGlob,
  executeGrep,
  executeFind,
  executeTree,
} from "./filesystem-tools.ts";
import { executeInspect } from "./inspect.ts";
import {
  extractSymbols,
  summarizeFile,
  contextExtract,
  summarizeDiff,
} from "./context-engine.ts";
import { executeCausalAnalyze } from "./causal-graph.ts";
import { renderEntropyReport } from "./entropy.ts";
import { evaluatorEngine } from "./evaluators.ts";
import {
  toolRegistry,
  executeToolSearch,
  executeToolsAvailable,
  type McpToolSchema,
} from "./tool-discovery.ts";
import { lspService } from "./lsp-service.ts";
import { performWebSearch, formatSearchResults } from "./web-search.ts";
import { DB_TOOLS, executeDbTool, isDbTool } from "./connectors/db-tools.ts";

export interface ToolExecutionContext {
  sessionId: string;
  prompt: string;
  messages: any[];
  actionLog: string[];
  mcpClients: Map<string, any>;
  mcpMatch?: { serverId: string; localName: string } | null;
}

export interface ToolExecutionOutput {
  result: string;
  actionSummary?: string;
}

// Built-in Tool Schemas for Model Function Calling
export const BUILTIN_TOOLS: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read and return the full content of a file from disk.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description:
              "Relative or absolute path to the file. Use real filenames.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description:
        "Write content to a file, creating it and parent directories if needed.",
      parameters: {
        type: "object",
        required: ["file_path", "content"],
        properties: {
          file_path: {
            type: "string",
            description: "Path where the file should be written.",
          },
          content: {
            type: "string",
            description: "Complete text content to write into the file.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Modify an existing file using safe structural operations (replace, insert_after, insert_before, delete, append, prepend).",
      parameters: {
        type: "object",
        required: ["file_path", "operation"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to modify.",
          },
          operation: {
            type: "string",
            enum: [
              "replace",
              "insert_after",
              "insert_before",
              "delete",
              "append",
              "prepend",
            ],
            description: "Structural edit operation to perform.",
          },
          old: {
            type: "string",
            description: "Target text snippet to replace or delete.",
          },
          new: {
            type: "string",
            description: "Replacement content to substitute in place of 'old'.",
          },
          anchor: {
            type: "string",
            description: "Anchor text snippet for insert_after or insert_before.",
          },
          content: {
            type: "string",
            description: "Content to insert, append, or prepend.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description:
        "Search file contents for regex or text occurrences with line numbers.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Text or regex search pattern.",
          },
          path: {
            type: "string",
            description: "Directory or file path to search.",
          },
          include: {
            type: "string",
            description: "File pattern filter (e.g. '*.ts', '*.json').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Find",
      description: "Locate files or directories by name, substring, or glob pattern (e.g. '*.ts', 'main.ts').",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Filename, substring, or glob pattern to find.",
          },
          path: {
            type: "string",
            description: "Directory to search from (defaults to '.').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Tree",
      description: "Visual directory tree hierarchy with depth control.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to map (defaults to '.').",
          },
          depth: {
            type: "number",
            description: "Maximum directory depth level (default: 3).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Inspect",
      description:
        "Single-shot introspection for project framework, hardware/VRAM, files, directories, processes, and configs in 1 call.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["project", "hardware", "file", "directory", "process", "config", "environment"],
            description: "What to inspect.",
          },
          path: {
            type: "string",
            description: "Path for target 'file' or 'directory'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ToolSearch",
      description: "Search specialized capabilities or list registry tools on demand (e.g. 'web search', 'lsp', 'database', 'all').",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords or 'all' to list (e.g. 'database', 'weather', 'calculator').",
          },
          category: {
            type: "string",
            description: "Optional filter category.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ExtractSymbols",
      description: "Extract function/class signatures and types (95% token savings).",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to source file.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SummarizeFile",
      description: "Structural file overview, imports, exports, and line counts.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to file to summarize.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ContextExtract",
      description: "Focused line window around a function/keyword with custom radius.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Target file path.",
          },
          query: {
            type: "string",
            description: "Symbol name or line number.",
          },
          radius: {
            type: "number",
            description: "Lines of context before and after (default: 15).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SummarizeDiff",
      description: "Concise summary of uncommitted git diffs or file diffs.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Optional file path to restrict diff.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "CausalAnalyze",
      description: "Constructs multi-step cause ➔ effect failure graphs with mitigations.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Failure symptom (e.g. 'Why is the application slow?').",
          },
          context: {
            type: "string",
            description: "Optional log snippet or stack trace.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "DeadCodeScan",
      description: "Project Garbage Collector & Codebase Entropy Engine.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional project root directory path.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "EvaluateOutput",
      description: "Autonomous Output Evaluator & Self-Critique Engine.",
      parameters: {
        type: "object",
        properties: {
          output: {
            type: "string",
            description: "The draft response or code to judge.",
          },
          target: {
            type: "string",
            description: "Optional specific criterion (code, security, task, style, all).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Execute a shell command inside the workspace sandbox.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "The bash command line to run.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Calculator",
      description:
        "Perform exact mathematical calculations, arithmetic expressions, and unit/temperature conversions (e.g. '(32 * 9/5) + 32' or '28 * 1.8 + 32').",
      parameters: {
        type: "object",
        required: ["expression"],
        properties: {
          expression: {
            type: "string",
            description:
              "Mathematical expression to evaluate (e.g. '(30 * 9/5) + 32', '144 / 12', 'sqrt(100) * 5').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Weather",
      description:
        "Fetches current live weather, temperature (in Celsius & Fahrenheit), humidity, and conditions for any city or location worldwide.",
      parameters: {
        type: "object",
        required: ["location"],
        properties: {
          location: {
            type: "string",
            description: "City name or location (e.g. 'Chennai', 'London', 'Tokyo').",
          },
          format: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Weather format: 'summary' (concise) or 'detailed' (full breakdown). Defaults to 'detailed'.",
          },
        },
      },
    },
  },
];

BUILTIN_TOOLS.push(...DB_TOOLS);

// Initialize tool catalog with core and specialized tools
export function setupToolRegistry(mcpTools: McpToolSchema[] = []) {
  const coreTools = new Set([
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Grep",
    "Find",
    "Inspect",
    "ToolSearch",
    "Weather",
    "Calculator",
  ]);

  for (const tool of BUILTIN_TOOLS) {
    if (tool.type !== "function" || !("function" in tool)) continue;
    const name = tool.function.name;
    let category: any = "specialized";
    if (["Read", "Write", "Delete", "Edit", "Tree", "Find", "Grep", "Glob"].includes(name))
      category = "filesystem";
    else if (["ExtractSymbols", "SummarizeFile", "ContextExtract", "SummarizeDiff"].includes(name))
      category = "compression";
    else if (["CausalAnalyze", "DeadCodeScan", "EvaluateOutput"].includes(name))
      category = "analysis";
    else if (name === "Bash") category = "terminal";
    else if (name === "Inspect") category = "introspection";
    else if (name === "Calculator") category = "utility";
    else if (name === "Weather" || name === "WebSearch") category = "web";
    else if (name.startsWith("LSP_")) category = "navigation";
    else if (name.startsWith("db_")) category = "database";

    toolRegistry.register({
      name,
      category,
      description: tool.function.description ?? "",
      schema: tool,
      isCore: coreTools.has(name),
    });
  }

  if (mcpTools.length > 0) {
    toolRegistry.registerMcpTools(mcpTools);
  }
}

// Format human-readable tool execution summary
export function formatToolSummary(
  toolName: string,
  args: any,
  filePath: string,
  mcpMatch?: { serverId: string; localName: string } | null,
): string {
  switch (toolName) {
    case "Read":
      return `📖 Reading  ${filePath}`;
    case "Write":
      return `📝 Writing  ${filePath}`;
    case "Delete":
    case "DeleteFile":
    case "RemoveFile":
      return `🗑️ Deleting ${filePath}`;
    case "Edit":
      return `✏️ Editing  ${filePath}`;
    case "Glob":
      return `🔎 Glob: "${args.pattern ?? ""}"`;
    case "Grep":
      return `🔍 Grep: "${args.query ?? ""}" in ${args.path ?? "."}`;
    case "Find":
      return `📂 Find: "${args.name ?? ""}"`;
    case "Tree":
      return `🌲 Tree: ${args.path ?? "."}`;
    case "Inspect":
      return `🔬 Inspecting: ${args.target ?? "project"}`;
    case "ToolSearch":
      return `🔎 Searching Tools: "${args.query ?? ""}"`;
    case "ToolsAvailable":
      return `🧰 Available Tools`;
    case "ExtractSymbols":
      return `📑 Extracting Symbols: ${filePath}`;
    case "SummarizeFile":
      return `🗜️ Summarizing File: ${filePath}`;
    case "ContextExtract":
      return `🎯 Context Window: ${filePath} (around "${args.query ?? ""}")`;
    case "SummarizeDiff":
      return `📊 Summarizing Diff: ${args.file_path ?? "all"}`;
    case "CausalAnalyze":
      return `🔬 Causal Analysis: "${args.query ?? ""}"`;
    case "DeadCodeScan":
      return `🧹 Scanning Dead Code & Project Entropy`;
    case "EvaluateOutput":
      return `🧠 Evaluating Output Quality & Safety`;
    case "WebSearch":
      return `🌐 Searching: "${args.query ?? ""}"`;
    case "LSP_Definition":
      return `🔍 LSP Definition: ${args.symbol ?? filePath}`;
    case "LSP_References":
      return `🔎 LSP References: ${args.symbol ?? filePath}`;
    case "LSP_DocumentSymbols":
      return `📑 LSP Symbols: ${filePath}`;
    case "LSP_Hover":
      return `ℹ️ LSP Hover: ${args.symbol ?? filePath}`;
    case "db_list_tables":
      return `📊 Database: Listing tables`;
    case "db_describe_table":
      return `📋 Database: Describing table ${args.table_name ?? ""}`;
    case "db_schema":
      return `🗄️ Database: Inspecting schema`;
    case "db_query":
      return `🔍 Database Query: "${String(args.query ?? "").slice(0, 45).replace(/\s+/g, " ")}"`;
    case "db_preview":
      return `👁️ Database: Previewing table ${args.table_name ?? ""} (${args.limit ?? 3} rows)`;
    case "db_relationships":
      return `🔗 Database: Inspecting relationships ${args.table_name ? `for ${args.table_name}` : `(all tables)`}`;
    case "db_search":
      return `🔎 Database: Searching columns matching "${args.keyword ?? ""}"`;
    case "db_explain":
      return `⚡ Database: Explaining query "${String(args.query ?? "").slice(0, 40).replace(/\s+/g, " ")}"`;
    case "Calculator":
    case "Calculate":
      return `🧮 Calculating: "${args.expression ?? args.query ?? ""}"`;
    case "Weather":
    case "get_weather":
      return `🌤️ Fetching Weather: ${args.location ?? "Chennai"}`;
    default:
      if (mcpMatch) {
        if (mcpMatch.serverId === "tools") {
          if (mcpMatch.localName === "get_time") return `⏱️ MCP: Get current time`;
          if (mcpMatch.localName === "list_files") return `📁 MCP: List files in ${args.dir ?? "."}`;
          if (mcpMatch.localName === "http_ping") return `🌐 MCP: Ping ${args.url ?? ""}`;
          if (mcpMatch.localName === "get_weather") return `🌤️ MCP: Weather for ${args.location ?? ""}`;
        }
        if (mcpMatch.serverId === "postgres") {
          if (mcpMatch.localName === "list_tables") return `📊 PostgreSQL: Listing tables`;
          if (mcpMatch.localName === "describe_table") return `📋 PostgreSQL: Describing table ${args.table_name ?? ""}`;
          if (mcpMatch.localName === "get_database_schema") return `🗄️ PostgreSQL: Inspecting DB schema`;
          if (mcpMatch.localName === "read_query") return `🔍 PostgreSQL Query: "${String(args.query ?? "").slice(0, 45).replace(/\s+/g, " ")}"`;
          if (mcpMatch.localName === "preview_table") return `👁️ Database: Previewing table ${args.table_name ?? ""} (${args.limit ?? 3} rows)`;
          if (mcpMatch.localName === "get_table_relationships") return `🔗 Database: Inspecting relationships ${args.table_name ? `for ${args.table_name}` : `(all tables)`}`;
          if (mcpMatch.localName === "search_columns") return `🔎 Database: Searching columns matching "${args.keyword ?? ""}"`;
          if (mcpMatch.localName === "explain_query") return `⚡ Database: Explaining query "${String(args.query ?? "").slice(0, 40).replace(/\s+/g, " ")}"`;
        }
        return `🔌 MCP [${mcpMatch.serverId}]: ${mcpMatch.localName}`;
      }
      return `⚡ Running: ${args.command ?? ""}`;
  }
}

// Extract target resource descriptor for permission evaluation & guardrails
export function extractToolTarget(
  toolName: string,
  args: any,
  filePath: string,
  mcpMatch?: { serverId: string; localName: string } | null,
): string {
  switch (toolName) {
    case "Delete":
    case "DeleteFile":
    case "RemoveFile":
      return filePath;
    case "Bash":
      return String(args.command ?? "");
    case "WebSearch":
    case "Grep":
      return String(args.query ?? "");
    case "Glob":
      return String(args.pattern ?? "");
    case "Find":
      return String(args.name ?? "");
    case "Tree":
      return String(args.path ?? ".");
    case "Inspect":
      return String(args.target ?? "project");
    case "ToolSearch":
      return String(args.query ?? "");
    case "ToolsAvailable":
      return String(args.category ?? "all");
    case "ExtractSymbols":
    case "SummarizeFile":
    case "ContextExtract":
      return filePath;
    case "SummarizeDiff":
      return String(args.file_path ?? "diff");
    case "CausalAnalyze":
      return String(args.query ?? "causal");
    case "DeadCodeScan":
      return String(args.path ?? "workspace");
    case "EvaluateOutput":
      return "output";
    case "Calculator":
    case "Calculate":
      return String(args.expression ?? args.query ?? "math");
    case "Weather":
    case "get_weather":
      return String(args.location ?? "Chennai");
    default:
      if (isDbTool(toolName)) {
        return String(args.table_name || args.query || args.keyword || args.schema || "database");
      }
      if (toolName.startsWith("LSP_")) return String(args.symbol ?? filePath);
      if (mcpMatch) {
        if (mcpMatch.serverId === "tools") {
          if (mcpMatch.localName === "get_weather") return String(args.location ?? "weather");
          if (mcpMatch.localName === "http_ping") return String(args.url ?? "ping");
          if (mcpMatch.localName === "list_files") return String(args.dir ?? ".");
          if (mcpMatch.localName === "get_time") return "time";
        }
        if (mcpMatch.serverId === "postgres") {
          if (mcpMatch.localName === "read_query" || mcpMatch.localName === "explain_query") return String(args.query ?? "");
          if (mcpMatch.localName === "describe_table" || mcpMatch.localName === "preview_table") return String(args.table_name ?? "");
          if (mcpMatch.localName === "get_table_relationships") return String(args.table_name ?? "all");
          if (mcpMatch.localName === "search_columns") return String(args.keyword ?? "");
        }
        return mcpMatch.localName;
      }
      return filePath;
  }
}

// Safe Mathematical Expression Evaluator
export function executeCalculate(rawExpression: string): string {
  try {
    const expr = String(rawExpression ?? "").trim();
    if (!expr) return "Error: Expression is required.";

    // Preprocessing: normalize operators and symbols
    let clean = expr
      .replace(/\^/g, "**")
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/π/gi, "Math.PI")
      .replace(/\bpi\b/gi, "Math.PI")
      .replace(/\be\b/gi, "Math.E");

    // Allow standard Math functions (sqrt, abs, round, floor, ceil, pow, sin, cos, tan, log, min, max)
    const mathFuncs = [
      "sqrt",
      "cbrt",
      "abs",
      "round",
      "floor",
      "ceil",
      "pow",
      "sin",
      "cos",
      "tan",
      "log",
      "log10",
      "min",
      "max",
    ];
    for (const fn of mathFuncs) {
      const regex = new RegExp(`\\b${fn}\\s*\\(`, "gi");
      clean = clean.replace(regex, `Math.${fn}(`);
    }

    // Security check: strictly disallow dangerous JavaScript tokens
    const forbidden = /(process|global|window|eval|Function|constructor|prototype|import|require|fs|child_process|exec|this|\[|\]|;)/i;
    if (forbidden.test(clean)) {
      return `Error: Invalid or forbidden tokens detected in mathematical expression "${expr}".`;
    }

    // Ensure expression only contains numbers, operators, commas, parentheses, dots, spaces, and allowed Math tokens
    const sanitized = clean.replace(/Math\.[a-zA-Z0-9]+/g, "");
    if (!/^[\d\s+\-*/%(),.eE]+$/.test(sanitized)) {
      return `Error: Expression contains invalid characters: "${expr}". Only mathematical numbers, operators (+, -, *, /, %, ^), and standard math functions are allowed.`;
    }

    const fn = new Function(`"use strict"; return (${clean});`);
    const val = fn();

    if (typeof val !== "number" || isNaN(val)) {
      return `Error: Expression did not evaluate to a valid number (result: ${val}).`;
    }

    const isInt = Number.isInteger(val);
    const formatted = isInt ? `${val}` : `${val.toFixed(2)} (exact: ${val})`;

    return [
      `🧮 Calculator Result:`,
      `• Expression : ${expr}`,
      `• Evaluated  : ${val}`,
      `• Formatted  : ${formatted}`,
    ].join("\n");
  } catch (err: any) {
    return `Error evaluating expression "${rawExpression}": ${err.message}`;
  }
}

// Live Weather Lookup (wttr.in with j1 json and summary formatting)
export async function executeWeather(
  location: string = "Chennai",
  format: string = "detailed",
): Promise<string> {
  const loc = String(location ?? "Chennai").trim();
  try {
    const encoded = encodeURIComponent(loc);
    if (format === "detailed") {
      const res = await fetch(`https://wttr.in/${encoded}?format=j1`, {
        headers: { "User-Agent": "curl/7.68.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return `Weather lookup failed: HTTP ${res.status}`;
      const data: any = await res.json();
      const current = data.current_condition?.[0] || {};
      const area = data.nearest_area?.[0]?.areaName?.[0]?.value || loc;
      return [
        `🌤️ Live Weather for ${area}:`,
        `• Condition   : ${current.weatherDesc?.[0]?.value ?? "Unknown"}`,
        `• Temperature : ${current.temp_C}°C (${current.temp_F}°F)`,
        `• Feels Like  : ${current.FeelsLikeC}°C (${current.FeelsLikeF}°F)`,
        `• Humidity    : ${current.humidity}%`,
        `• Wind        : ${current.windspeedKmph} km/h ${current.winddir16Point ?? ""}`,
        `• UV Index    : ${current.uvIndex ?? "N/A"}`,
      ].join("\n");
    } else {
      const res = await fetch(
        `https://wttr.in/${encoded}?format=%l:+%C,+%t+(feels+like+%f),+Humidity:+%h,+Wind:+%w`,
        {
          headers: { "User-Agent": "curl/7.68.0" },
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!res.ok) return `Weather lookup failed: HTTP ${res.status}`;
      const text = await res.text();
      return `🌤️ Live Weather: ${text.trim()}`;
    }
  } catch (err: any) {
    return `Error fetching live weather for "${loc}": ${err.message}`;
  }
}

// Central Tool Dispatcher & Execution Engine
export async function executeTool(
  toolName: string,
  args: any,
  filePath: string,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutput> {
  let result: string;
  let actionSummary: string | undefined;

  if (isDbTool(toolName)) {
    result = await executeDbTool(toolName, args);
    actionSummary = formatToolSummary(toolName, args, filePath);
    return { result, actionSummary };
  }

  switch (toolName) {
    case "Read": {
      result = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf-8")
        : `Error: file not found: ${filePath}`;
      if (!result.startsWith("Error:")) actionSummary = `Read ${filePath}`;
      break;
    }
    case "Write": {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, args.content ?? "", "utf-8");
        result = `Written: ${filePath}`;
        actionSummary = `Wrote ${filePath}`;
      } catch (e: any) {
        result = `Error writing ${filePath}: ${e.message}`;
      }
      break;
    }
    case "Delete":
    case "DeleteFile":
    case "RemoveFile": {
      try {
        if (!fs.existsSync(filePath)) {
          result = `File not found: ${filePath}`;
        } else {
          fs.unlinkSync(filePath);
          result = `Deleted: ${filePath}`;
          actionSummary = `Deleted ${filePath}`;
        }
      } catch (e: any) {
        result = `Error deleting ${filePath}: ${e.message}`;
      }
      break;
    }
    case "Edit": {
      result = executeEdit(filePath, args);
      if (!result.startsWith("Error:")) actionSummary = `Edited ${filePath}`;
      break;
    }
    case "Glob": {
      const pat = String(args.pattern ?? "");
      result = executeGlob(pat, args.path ? path.resolve(process.cwd(), args.path) : process.cwd());
      if (!result.startsWith("Error:")) actionSummary = `Glob: ${pat}`;
      break;
    }
    case "Grep": {
      const q = String(args.query ?? "");
      result = executeGrep(q, args.path ? path.resolve(process.cwd(), args.path) : ".", args.include);
      if (!result.startsWith("Error:")) actionSummary = `Grep: "${q}"`;
      break;
    }
    case "Find": {
      const n = String(args.name ?? "");
      result = executeFind(n, args.path ? path.resolve(process.cwd(), args.path) : ".");
      if (!result.startsWith("Error:")) actionSummary = `Find: ${n}`;
      break;
    }
    case "Tree": {
      result = executeTree(args.path ? path.resolve(process.cwd(), args.path) : ".", Number(args.depth ?? 3));
      if (!result.startsWith("Error:")) actionSummary = `Tree: ${args.path ?? "."}`;
      break;
    }
    case "Inspect": {
      result = executeInspect(args);
      if (!result.startsWith("Error:")) actionSummary = `Inspect ${args.target || "project"}`;
      break;
    }
    case "ToolSearch": {
      result = executeToolSearch(String(args.query ?? ""), args.category);
      if (!result.startsWith("Error:")) actionSummary = `ToolSearch: ${args.query}`;
      break;
    }
    case "ToolsAvailable": {
      result = executeToolsAvailable(args.category);
      if (!result.startsWith("Error:")) actionSummary = `ToolsAvailable`;
      break;
    }
    case "ExtractSymbols": {
      result = extractSymbols(filePath);
      if (!result.startsWith("Error:")) actionSummary = `ExtractSymbols: ${filePath}`;
      break;
    }
    case "SummarizeFile": {
      result = summarizeFile(filePath);
      if (!result.startsWith("Error:")) actionSummary = `SummarizeFile: ${filePath}`;
      break;
    }
    case "ContextExtract": {
      result = contextExtract(filePath, args.query, Number(args.radius ?? 15));
      if (!result.startsWith("Error:")) actionSummary = `ContextExtract: ${filePath}`;
      break;
    }
    case "SummarizeDiff": {
      result = summarizeDiff(args.file_path);
      if (!result.startsWith("Error:")) actionSummary = `SummarizeDiff`;
      break;
    }
    case "CausalAnalyze": {
      result = executeCausalAnalyze(String(args.query ?? ""), args.context);
      if (!result.startsWith("Error:")) actionSummary = `CausalAnalyze: ${args.query}`;
      break;
    }
    case "DeadCodeScan": {
      result = renderEntropyReport(args.path ? path.resolve(process.cwd(), args.path) : process.cwd());
      if (!result.startsWith("Error:")) actionSummary = `DeadCodeScan`;
      break;
    }
    case "EvaluateOutput": {
      const evalRes = await evaluatorEngine.evaluate({
        prompt: ctx.prompt,
        output: String(args.output ?? ""),
        actionLog: ctx.actionLog,
        messages: ctx.messages,
      });
      result = evaluatorEngine.formatEvaluationReport(evalRes);
      actionSummary = `EvaluateOutput [${evalRes.verdict} - ${evalRes.overallScore}/100]`;
      break;
    }
    case "Bash": {
      let command = args.command ?? "";
      if (typeof command === "object" && command !== null) {
        command = (command as any).command ?? (command as any).cmd ?? String(command);
      }
      let cmdStr = String(command);
      if (process.platform === "win32") {
        // Strip redundant sh -c wrappers on Windows
        const shMatch = cmdStr.match(/^sh\s+-c\s+["'](.*)["']$/s);
        if (shMatch) cmdStr = shMatch[1];

        // Normalize ambiguous Linux flags in PowerShell (e.g. rm -f -> Remove-Item -Force)
        cmdStr = cmdStr
          .replace(/\brm\s+-rf\b/g, "Remove-Item -Recurse -Force")
          .replace(/\brm\s+-f\b/g, "Remove-Item -Force")
          .replace(/\bls\s+-la\b/g, "Get-ChildItem -Force")
          .replace(/\bls\s+-l\b/g, "Get-ChildItem");
      }
      try {
        result = await new Promise<string>((resolve) => {
          exec(
            cmdStr,
            { shell: process.platform === "win32" ? "powershell.exe" : undefined },
            (err, stdout, stderr) => {
              if (err) resolve(`Error: ${stderr || err.message}`);
              else resolve(stdout.trim() || "Command executed successfully.");
            },
          );
        });
        actionSummary = `Ran: ${command}`;
      } catch (e: any) {
        result = `Error: ${e.message}`;
      }
      break;
    }
    case "WebSearch": {
      const query = String(args.query ?? "").trim();
      try {
        const searchResults = await performWebSearch(query);
        result = formatSearchResults(query, searchResults);
        actionSummary = `Web search: "${query}"`;
      } catch (e: any) {
        result = `Error executing web search: ${e.message}`;
      }
      break;
    }
    case "Calculator":
    case "Calculate": {
      const expr = String(args.expression ?? args.query ?? args.input ?? "");
      result = executeCalculate(expr);
      actionSummary = `Calculated: ${expr}`;
      break;
    }
    case "Weather":
    case "get_weather": {
      const loc = String(args.location ?? "Chennai");
      result = await executeWeather(loc, args.format ?? "detailed");
      actionSummary = `Weather: ${loc}`;
      break;
    }
    case "LSP_Definition": {
      try {
        const locs = await lspService.getDefinition(filePath, Number(args.line ?? 1), Number(args.character ?? 1), args.symbol);
        result = locs.length > 0
          ? `Definition(s) found:\n${locs.map((l) => `  • ${l.filePath}:${l.line}:${l.character} -> "${l.preview}"`).join("\n")}`
          : `No definition found for "${args.symbol || filePath}".`;
        actionSummary = `LSP Definition: ${args.symbol || filePath}`;
      } catch (e: any) {
        result = `Error fetching definition: ${e.message}`;
      }
      break;
    }
    case "LSP_References": {
      try {
        const refs = await lspService.getReferences(filePath, Number(args.line ?? 1), Number(args.character ?? 1), args.symbol);
        result = refs.length > 0
          ? `Reference(s) found (${refs.length}):\n${refs.slice(0, 20).map((r) => `  • ${r.filePath}:${r.line}:${r.character} -> "${r.lineContent}"`).join("\n")}`
          : `No references found for "${args.symbol || filePath}".`;
        actionSummary = `LSP References: ${args.symbol || filePath}`;
      } catch (e: any) {
        result = `Error fetching references: ${e.message}`;
      }
      break;
    }
    case "LSP_DocumentSymbols": {
      try {
        const syms = await lspService.getDocumentSymbols(filePath);
        result = syms.length > 0
          ? `Document symbols for ${filePath} (${syms.length}):\n${syms.map((s) => `  • [${s.kind}] ${s.name} (L${s.line}) -> "${s.preview}"`).join("\n")}`
          : `No symbols found in ${filePath}.`;
        actionSummary = `LSP Symbols: ${filePath}`;
      } catch (e: any) {
        result = `Error fetching document symbols: ${e.message}`;
      }
      break;
    }
    case "LSP_Hover": {
      try {
        result = await lspService.getHover(filePath, Number(args.line ?? 1), Number(args.character ?? 1), args.symbol);
        actionSummary = `LSP Hover: ${args.symbol || filePath}`;
      } catch (e: any) {
        result = `Error fetching hover documentation: ${e.message}`;
      }
      break;
    }
    default: {
      if (ctx.mcpMatch) {
        const client = ctx.mcpClients.get(ctx.mcpMatch.serverId);
        if (client) {
          try {
            result = await client.callTool(ctx.mcpMatch.localName, args);
            actionSummary = `MCP [${ctx.mcpMatch.serverId}]: ${ctx.mcpMatch.localName}`;
          } catch (e: any) {
            result = `Error calling MCP tool: ${e.message}`;
          }
        } else {
          result = `MCP client not found: ${ctx.mcpMatch.serverId}`;
        }
      } else {
        result = `Unknown tool: ${toolName}`;
      }
      break;
    }
  }

  return { result, actionSummary };
}
