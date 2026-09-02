import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { McpClient, type McpToolSchema } from "./mcp-client.ts";
import { appendSessionMessage, trimContextMessages } from "./session.ts";
import { loadAllSkills, matchSkill } from "./skills.ts";
import { performWebSearch, formatSearchResults } from "./web-search.ts";
import {
  loadPermissionConfig,
  evaluatePermission,
  promptUserPermission,
  type PermissionAction,
} from "./permissions.ts";
import { resolveModel, modelSupportsVision } from "./models.ts";
import { lspService } from "./lsp-service.ts";
import { executeHooks, loadHooksConfig } from "./hooks.ts";
import {
  recordTurnTelemetry,
  estimateTokens,
  estimateMessagesTokens,
  fetchModelContextStats,
} from "./telemetry.ts";
import {
  validatePathSafety,
  validateCommandSafety,
  sanitizeSecrets,
  createToolLoopDetector,
} from "./guardrails.ts";
import {
  executeGlob,
  executeGrep,
  executeFind,
  executeTree,
  executeEdit,
} from "./filesystem-tools.ts";
import { executeInspect } from "./inspect.ts";
import { eventBus } from "./events.ts";
import {
  toolRegistry,
  executeToolSearch,
  executeToolsAvailable,
} from "./tool-discovery.ts";
import {
  extractSymbols,
  summarizeFile,
  contextExtract,
  summarizeDiff,
  compressHistory,
} from "./context-engine.ts";

// Constants
const PLACEHOLDER_RE =
  /^(?:[/\\])?(?:(?:path|your)[/\\]to[/\\](?:your[/\\])?|your[/\\]project[/\\])/i;

const TOOL_CALL_OBJ_RE =
  /\{[^{}]*"(?:name|function|tool)"\s*:\s*"[^"]+"[^{}]*\}/g;

const MCP_CONFIG_PATH = path.resolve(process.cwd(), ".agents", "mcp.json");

// ANSI color helpers
const colors = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  boldMagenta: (s: string) => `\x1b[1;35m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

// Types
export type ExecutionMode = "cli" | "server" | "repl";

// Path resolution
export function resolveFilePath(raw: any): string {
  if (!raw) return "";

  let filePath: string =
    typeof raw === "string" ? raw : (raw.file_path ?? raw.path ?? "");

  // Strip Git Bash /cygdrive or /c/ prefix
  filePath = filePath.replace(/^[A-Za-z]:[/\\]Program Files[/\\]Git[/\\]/i, "");
  filePath = filePath.replace(/^\/[a-zA-Z]\//, (m) => m[1].toUpperCase() + ":/");

  // Normalize Windows paths
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(process.cwd(), filePath);
}

// Parse tool arguments safely
export function parseToolArguments(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      const trimmed = raw.trim();
      try {
        const fixed = trimmed
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        return JSON.parse(fixed);
      } catch {
        return { file_path: trimmed, command: trimmed };
      }
    }
  }
  return {};
}

// Match tool name against known tools (case-insensitive, snake_case, PascalCase, MCP prefix)
function matchKnownTool(name: string, knownTools: Set<string>): string | null {
  if (!name) return null;
  if (knownTools.has(name)) return name;

  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Priority: check if it matches an MCP tool suffix (e.g. get_time, gettime -> mcp__tools__get_time)
  for (const k of knownTools) {
    if (k.startsWith("mcp__")) {
      const suffix = k.replace(/^mcp__[^_]+__/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (suffix === clean) return k;
    }
  }

  // General normalized match
  for (const k of knownTools) {
    const kClean = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (kClean === clean) return k;
  }

  return null;
}

// Extract embedded tool calls from text
export function extractEmbeddedToolCall(
  content: string,
  knownTools: Set<string> = new Set([
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Find",
    "Tree",
    "Inspect",
    "ToolSearch",
    "ToolsAvailable",
    "ExtractSymbols",
    "SummarizeFile",
    "ContextExtract",
    "SummarizeDiff",
    "Bash",
    "WebSearch",
    "LSP_Definition",
    "LSP_References",
    "LSP_DocumentSymbols",
    "LSP_Hover",
  ]),
): any | null {
  const candidates: string[] = [];

  const codeBlock = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let m: RegExpExecArray | null;
  while ((m = codeBlock.exec(content)) !== null) candidates.push(m[1]);

  let depth = 0,
    start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{") {
      if (depth++ === 0) start = i;
    } else if (content[i] === "}" && depth > 0) {
      if (--depth === 0 && start !== -1) {
        candidates.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }

  for (const raw of candidates) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* fallback */
    }

    if (!parsed) {
      try {
        const fixed = raw
          .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
          .replace(/:\s*([A-Za-z][A-Za-z0-9_]*)(?=[,}\s])/g, ': "$1"');
        parsed = JSON.parse(fixed);
      } catch {
        continue;
      }
    }

    if (!parsed || typeof parsed !== "object") continue;

    const rawToolName: string =
      parsed.name ?? parsed.function ?? parsed.tool ?? "";
    const toolName = matchKnownTool(rawToolName, knownTools);
    if (!toolName) continue;

    const toolArgs =
      parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};

    // Ignore fake tool calls containing final answer/response
    if (toolArgs && typeof toolArgs === "object") {
      if (toolArgs.response || toolArgs.answer || toolArgs.output || toolArgs.result) {
        continue;
      }
    }

    return {
      id: "call_" + Math.random().toString(36).slice(2, 9),
      type: "function",
      function: {
        name: toolName,
        arguments:
          typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs),
      },
    };
  }

  // Check for tuple format fallback: "ToolName", { "arg": "value" ... }
  const tupleRegex = /["']?([A-Za-z0-9_]+)["']?\s*,\s*(\{[\s\S]*)/;
  const tupleMatch = content.match(tupleRegex);
  if (tupleMatch) {
    const toolName = matchKnownTool(tupleMatch[1], knownTools);
    if (toolName) {
      let rawArgs = tupleMatch[2].trim();
      if (!rawArgs.endsWith("}")) rawArgs += "}";
      try {
        const parsedArgs = JSON.parse(rawArgs);
        if (parsedArgs && typeof parsedArgs === "object") {
          if (parsedArgs.response || parsedArgs.answer || parsedArgs.output || parsedArgs.result) {
            return null;
          }
        }
        return {
          id: "call_" + Math.random().toString(36).slice(2, 9),
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify(parsedArgs),
          },
        };
      } catch {
        try {
          const fixed = rawArgs
            .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
            .replace(/:\s*([A-Za-z0-9_./\\]+)(?=[,}\s])/g, ': "$1"');
          const parsedArgs = JSON.parse(fixed);
          if (parsedArgs && typeof parsedArgs === "object") {
            if (parsedArgs.response || parsedArgs.answer || parsedArgs.output || parsedArgs.result) {
              return null;
            }
          }
          return {
            id: "call_" + Math.random().toString(36).slice(2, 9),
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(parsedArgs),
            },
          };
        } catch {
          /* fall through */
        }
      }
    }
  }

  return null;
}

// Strip tool call artifacts and tags from content
export function cleanAssistantContent(raw: string): string {
  if (!raw) return "";

  let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // If model wrapped its final response in a JSON object: {"response": "..."}
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") {
      const inner = parsed.arguments ?? parsed;
      const val =
        inner.response ||
        inner.answer ||
        inner.output ||
        inner.result ||
        inner.message;
      if (val) return String(val);
    }
  } catch {
    const respMatch = clean.match(
      /"(?:response|answer|output|result|message)"\s*:\s*"([^"]+)/i,
    );
    if (respMatch) {
      return respMatch[1];
    }
  }

  clean = clean.replace(TOOL_CALL_OBJ_RE, "");
  clean = clean.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/g, "");
  clean = clean.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  clean = clean.replace(/<[^>]+>/g, "").trim();

  if (
    !clean ||
    clean === "{}" ||
    clean === "}" ||
    clean.includes("<none>") ||
    clean.includes('"none"')
  ) {
    return "";
  }
  return clean;
}

// Built-in tools
export const BUILTIN_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
              "Relative or absolute path to the file. Use the real filename — NOT placeholder paths like /path/to/file.",
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
        "Write content to a file, creating it (and any parent directories) if needed.",
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
            description: "The full content to write.",
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
        "Perform first-class structural code edits on existing files. Supports operations: 'replace' (default), 'insert_after', 'insert_before', 'delete', 'append', 'prepend' with automatic syntax integrity checks to prevent file corruption.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to edit.",
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
            description:
              "Edit operation to perform. Defaults to 'replace'.",
          },
          old_string: {
            type: "string",
            description:
              "Existing text block to replace or delete (for 'replace' or 'delete').",
          },
          new_string: {
            type: "string",
            description: "Replacement content for 'replace'.",
          },
          anchor: {
            type: "string",
            description:
              "Anchor text or line to find for 'insert_after' or 'insert_before'.",
          },
          content: {
            type: "string",
            description:
              "Text content to insert, append, or prepend.",
          },
          replace_all: {
            type: "boolean",
            description:
              "If true, replace all occurrences. Defaults to false.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description:
        "Find files matching a glob pattern (e.g. 'src/**/*.ts', 'app/*.json', '**/*.tsx'). Fast and token-efficient.",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: {
            type: "string",
            description:
              "Glob pattern to match files against (e.g. '**/*.ts', 'src/**/*.vue').",
          },
          path: {
            type: "string",
            description:
              "Optional root directory to search from. Defaults to project root.",
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
        "Search file contents for regex or substring matches across the codebase. Returns file paths with matching line numbers and text.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "Substring or regular expression to search for in file contents.",
          },
          path: {
            type: "string",
            description:
              "Optional file or directory path to search within. Defaults to current directory.",
          },
          include: {
            type: "string",
            description:
              "Optional glob filter to restrict files (e.g. '*.ts', '*.py').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Find",
      description:
        "Quickly locate files or directories matching a name or substring across the workspace.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description:
              "Filename or substring to search for (e.g. 'package.json', 'models').",
          },
          path: {
            type: "string",
            description: "Optional directory to search within.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Tree",
      description:
        "Generate a structured visual directory tree showing the hierarchy of files and folders up to a maximum depth.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional root directory to generate tree for. Defaults to current workspace.",
          },
          depth: {
            type: "number",
            description: "Maximum depth level (default: 3).",
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
        "Single-shot generalized introspection primitive. Quickly inspects project tech stack (frameworks, runtime, package manager, tests, linters, git), file metadata, directory summaries, process resources, system environment, or active agent configuration in one call.",
      parameters: {
        type: "object",
        required: ["target"],
        properties: {
          target: {
            type: "string",
            enum: [
              "project",
              "file",
              "directory",
              "process",
              "environment",
              "config",
            ],
            description:
              "The introspection target: 'project' (tech stack, framework, runtime, tests, linters, git), 'file' (size, lines, format), 'directory' (file counts, extensions), 'process' (PID, memory, uptime), 'environment' (OS, tools in PATH), or 'config' (active models, rules).",
          },
          path: {
            type: "string",
            description:
              "Optional file or directory path to inspect (for 'project', 'file', or 'directory'). Defaults to current project directory.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Execute a shell command and return its output.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description:
              "The shell command to run (e.g. 'ls app/', 'git status', 'cat package.json').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebSearch",
      description:
        "Search the live web for real-time information, documentation, news, or external references.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "The search query to look up on the web.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "LSP_Definition",
      description:
        "Go to definition: Find where a function, class, interface, type, or variable is defined in the codebase.",
      parameters: {
        type: "object",
        required: ["symbol"],
        properties: {
          symbol: {
            type: "string",
            description: "Name of the symbol (function, class, type) to locate.",
          },
          file_path: {
            type: "string",
            description: "Optional file path where the symbol is referenced.",
          },
          line: {
            type: "number",
            description: "Optional 1-indexed line number in file_path.",
          },
          character: {
            type: "number",
            description: "Optional 1-indexed column number in file_path.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "LSP_References",
      description:
        "Find all references and usages of a symbol across all files in the project.",
      parameters: {
        type: "object",
        required: ["symbol"],
        properties: {
          symbol: {
            type: "string",
            description: "Name of the symbol or function to find usages for.",
          },
          file_path: {
            type: "string",
            description: "Optional file path where the symbol is located.",
          },
          line: {
            type: "number",
            description: "Optional 1-indexed line number.",
          },
          character: {
            type: "number",
            description: "Optional 1-indexed column number.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "LSP_DocumentSymbols",
      description:
        "Extract document symbols (functions, classes, interfaces, types, methods) from a file.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to outline symbols for.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "LSP_Hover",
      description:
        "Get type signatures, docstrings, or preview information for a symbol or location.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file.",
          },
          symbol: {
            type: "string",
            description: "Optional symbol name to inspect.",
          },
          line: {
            type: "number",
            description: "Optional 1-indexed line number.",
          },
          character: {
            type: "number",
            description: "Optional 1-indexed column number.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ToolSearch",
      description:
        "On-demand tool discovery. Search for and dynamically activate specialized tools into the model's active context (e.g. search for 'database', 'web search', 'lsp', 'git', 'docker', or MCP capabilities).",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "Keyword or capability to search for (e.g. 'web search', 'database', 'lsp', 'git', 'mcp').",
          },
          category: {
            type: "string",
            description:
              "Optional category filter: 'filesystem', 'terminal', 'introspection', 'navigation', 'web', 'database', 'mcp', 'specialized'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ToolsAvailable",
      description:
        "List all available tool catalogs and categories without cluttering prompt context.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Optional category to filter by.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ExtractSymbols",
      description:
        "Extract all function signatures, classes, interfaces, and type declarations from a file without loading full internal implementation bodies (up to 95% token savings).",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the code file to extract outline from.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SummarizeFile",
      description:
        "Generate a compressed high-level summary of a large file, including dependencies, structural outline, and line counts, to avoid reading thousands of lines.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to summarize.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ContextExtract",
      description:
        "Extract a focused window of lines around a specific function, line number, or keyword with a custom context radius, avoiding full file reads.",
      parameters: {
        type: "object",
        required: ["file_path", "query"],
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file.",
          },
          query: {
            type: "string",
            description: "Function name, keyword, or line number to center the context slice around.",
          },
          radius: {
            type: "number",
            description: "Number of lines of leading and trailing context (default: 15).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SummarizeDiff",
      description:
        "Generate a concise statistical and functional summary of uncommitted git changes or diffs.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Optional specific file to check git diff for.",
          },
        },
      },
    },
  },
];

// Initialize tool catalog with core and specialized tools
function setupToolRegistry(mcpTools: McpToolSchema[] = []) {
  const coreTools = new Set([
    "Inspect",
    "Read",
    "Write",
    "Edit",
    "Tree",
    "Find",
    "Grep",
    "ExtractSymbols",
    "SummarizeFile",
    "ContextExtract",
    "SummarizeDiff",
    "Bash",
    "ToolSearch",
    "ToolsAvailable",
  ]);

  for (const tool of BUILTIN_TOOLS) {
    const name = tool.function.name;
    let category: any = "specialized";
    if (["Read", "Write", "Edit", "Tree", "Find", "Grep", "Glob"].includes(name))
      category = "filesystem";
    else if (["ExtractSymbols", "SummarizeFile", "ContextExtract", "SummarizeDiff"].includes(name))
      category = "compression";
    else if (name === "Bash") category = "terminal";
    else if (name === "Inspect") category = "introspection";
    else if (name.startsWith("LSP_")) category = "navigation";
    else if (name === "WebSearch") category = "web";
    else if (name === "ToolSearch" || name === "ToolsAvailable")
      category = "specialized";

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

// Load MCP clients
async function loadMcpClients(): Promise<Map<string, McpClient>> {
  const clients = new Map<string, McpClient>();
  if (!fs.existsSync(MCP_CONFIG_PATH)) return clients;

  let config: {
    servers?: Array<{ id: string; command: string; args?: string[] }>;
  };
  try {
    config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
  } catch (e: any) {
    process.stderr.write(`[MCP] Failed to parse mcp.json: ${e.message}\n`);
    return clients;
  }

  for (const srv of config.servers ?? []) {
    const client = new McpClient(srv.id, srv.command, srv.args ?? []);
    try {
      await client.connect();
      clients.set(srv.id, client);
    } catch (e: any) {
      process.stderr.write(
        `[MCP] Failed to connect "${srv.id}": ${e.message}\n`,
      );
    }
  }

  return clients;
}

// Convert local image file to base64 Data URL
export function encodeLocalImageToDataUrl(filePath: string): string | null {
  try {
    const cleanPath = filePath.replace(/^['"]|['"]$/g, "").trim();
    const resolved = path.resolve(process.cwd(), cleanPath);
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return null;

    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
    };

    const mime = mimeMap[ext] ?? "image/png";
    const data = fs.readFileSync(resolved);
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

// Core agent loop
export async function runAgentMode(
  prompt: string,
  messages: any[],
  sessionFilePath?: string,
  mode: ExecutionMode = "cli",
  notifyTool?: (toolName: string, summary: string) => void,
  onToken?: (token: string) => void,
  imagePaths?: string[],
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const llm = new OpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  });
  const model = process.env.MODEL ?? "qwen2.5-coder:7b-instruct-q3_k_m";
  const modelInfo = resolveModel(model);
  const agentName =
    modelInfo.name || process.env.AGENT_NAME || "an expert coding assistant";

  // Discover and merge MCP tools
  const mcpClients = await loadMcpClients();
  const mcpTools: McpToolSchema[] = [];
  for (const c of mcpClients.values()) mcpTools.push(...c.getTools());
  
  // Setup Tool Discovery Registry
  setupToolRegistry(mcpTools);
  let allTools = [...BUILTIN_TOOLS, ...mcpTools];

  // Discover and match skills
  const skills = loadAllSkills();
  const activeSkill = matchSkill(prompt, skills);

  // Enforce tool restrictions if active skill specifies allowed tools
  if (activeSkill?.tools && activeSkill.tools.length > 0) {
    const allowedSet = new Set(activeSkill.tools);
    allTools = allTools.filter(
      (t) =>
        allowedSet.has(t.function.name) ||
        allowedSet.has(t.function.name.replace(/^mcp__[^_]+__/, "")),
    );
  }

  const allToolNames = new Set([
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Find",
    "Tree",
    "Inspect",
    "ToolSearch",
    "ToolsAvailable",
    "ExtractSymbols",
    "SummarizeFile",
    "ContextExtract",
    "SummarizeDiff",
    "Bash",
    "WebSearch",
    ...allTools.map((t) => t.function.name),
  ]);

  // Notify skill activation in terminal
  if (activeSkill) {
    process.stdout.write(
      `  ${colors.dim("↳")} ${colors.boldMagenta(`[Skill: ${activeSkill.name}]`)} ${colors.gray(activeSkill.description.slice(0, 70))}...\n`,
    );
  }

  // System prompt
  if (messages.length === 0 || messages[0].role !== "system") {
    const mcpList =
      mcpTools.length > 0
        ? `\nMCP tools available: ${mcpTools.map((t) => t.function.name.replace(/^mcp__[^_]+__/, "")).join(", ")}.`
        : "";
    const skillList =
      skills.length > 0
        ? `\nAvailable skills: ${skills.map((s) => s.name).join(", ")}.`
        : "";
    const activeSkillPrompt = activeSkill
      ? `\n\n--- ACTIVE SKILL: ${activeSkill.name} ---\n${activeSkill.instructions}\n----------------------------------`
      : "";

    messages.unshift({
      role: "system",
      content: `You are ${agentName}, an autonomous coding assistant.
Use tools to answer requests:
- Single-Shot Introspection:
  - Inspect: Instantly introspect the environment in 1 call instead of running multiple commands!
    • inspect("project"): Returns frameworks, runtime, package manager, test runner, linters, and git branch in one shot.
    • inspect("file", path): Line count, size, type, and preview.
    • inspect("directory", path): Subdirectory count, file counts, and extension breakdown.
    • inspect("environment"): OS, CPU, memory, and tools in PATH (bun, node, git, python, etc.).
    • inspect("process"): PID, memory usage (RSS/heap), uptime, and architecture.
    • inspect("config"): Active model, permission policies, hooks, and skills.
- Context Compression & Low-VRAM Efficiency:
  - ExtractSymbols: Extract all function signatures, classes, interfaces, and types from a file without loading full bodies (95% token savings!).
  - SummarizeFile: Get compressed structural overview, dependencies, and outline of large files.
  - ContextExtract: Extract a focused window of lines around a specific function/keyword with custom radius instead of reading full 1,000+ line files.
  - SummarizeDiff: Concise statistics and functional changes in uncommitted git diffs.
- On-Demand Tool Discovery:
  - ToolSearch: When you need specialized capabilities (web search, LSP code navigation, database tools, MCP integrations), search for and dynamically activate them (e.g. ToolSearch({ query: "web search" }) or ToolSearch({ query: "lsp" })).
  - ToolsAvailable: List available tool categories without consuming context.
- File Operations:
  - Read: Read full file contents.
  - Write: Create new files or overwrite complete files.
  - Edit: Modify existing files using structural operations (replace, insert_after, insert_before, delete, append, prepend) with automatic syntax integrity checks.
- Filesystem & Search Intelligence:
  - Tree: Explore directory structure and hierarchy (e.g. tree("app/", 2)).
  - Find: Locate files or directories by name (e.g. find("package.json")).
  - Grep: Search file contents for keywords, regex, or code occurrences with line numbers (e.g. grep("useEffect", "src/")).
- Shell:
  - Bash: Execute build, test, git, or command-line tasks.${mcpList}${skillList}${activeSkillPrompt}
- Task Alignment: Stay strictly focused on the user's specific coding task. Do not deviate or execute unrelated system tasks.
- Security & Path Safety: Never attempt to access private keys (.ssh), cloud credentials (.aws), system directories (C:\\Windows, /etc), or execute destructive filesystem commands.
- Loop Prevention: When a tool returns a result or error, do NOT invoke the exact same tool with identical arguments again. Instead, present that answer or explain the issue in natural language to the user.
- Never output raw JSON tool calls in your final response.`,
    });
  }

  // Build multimodal user message if images are attached
  const contentBlocks: any[] = [{ type: "text", text: prompt }];

  if (imagePaths && imagePaths.length > 0) {
    for (const imgPath of imagePaths) {
      const dataUrl = encodeLocalImageToDataUrl(imgPath);
      if (dataUrl) {
        contentBlocks.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      } else {
        process.stderr.write(`[Vision] Warning: Image file not found: ${imgPath}\n`);
      }
    }
  }

  if (contentBlocks.length > 1) {
    if (!modelSupportsVision(model)) {
      process.stdout.write(
        `  ${colors.dim("↳")} ${colors.boldYellow("⚠️ Note:")} ${colors.gray(`${modelInfo.name} may not support vision. For best image analysis, switch to: gemma, qwen3.5, or ministral.\n`)}`,
      );
    } else {
      process.stdout.write(
        `  ${colors.dim("↳")} ${colors.boldGreen("📷 [Vision Input]")} ${colors.cyan(`${contentBlocks.length - 1} image(s) loaded into context`)}\n`,
      );
    }
  }

  const userMessage =
    contentBlocks.length > 1
      ? { role: "user", content: contentBlocks }
      : { role: "user", content: prompt };

  messages.push(userMessage);
  if (sessionFilePath)
    appendSessionMessage(sessionFilePath, userMessage);

  const actionLog: string[] = [];
  const MAX_TURNS = 8;
  let turns = 0;

  // Load permission, hooks, and security guardrail configuration
  const permConfig = loadPermissionConfig();
  const runtimePermCache = new Map<string, PermissionAction>();
  const hooksConfig = loadHooksConfig();
  const loopDetector = createToolLoopDetector(3);
  const sessionStartTime = performance.now();
  const sessionId = sessionFilePath
    ? path.basename(sessionFilePath, ".jsonl")
    : "session_" + Date.now().toString(36);
  const modelStats = await fetchModelContextStats(model);

  // Emit session.started event
  eventBus.emit({
    type: "session.started",
    sessionId,
    model,
    timestamp: new Date().toISOString(),
  });

  try {
    while (turns++ < MAX_TURNS) {
      const turnStart = performance.now();
      let firstTokenTime = 0;
      let turnToolTimeMs = 0;
      let turnErrors = 0;

      const thinkingEffort = process.env.THINKING_EFFORT?.toLowerCase().trim();

      // Emit model.started event
      eventBus.emit({
        type: "model.started",
        sessionId,
        turn: turns,
        model,
        prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
        thinkingEffort,
        timestamp: new Date().toISOString(),
      });

      // Intelligent low-VRAM history compaction
      const { messages: compactedMessages, compacted: didCompact } =
        compressHistory(messages, modelStats.configuredContextLength || 8000);
      if (didCompact) {
        eventBus.emit({
          type: "context.compacted",
          sessionId,
          beforeTokens: estimateMessagesTokens(messages),
          afterTokens: estimateMessagesTokens(compactedMessages),
          timestamp: new Date().toISOString(),
        });
      }

      const requestPayload: any = {
        model,
        messages: trimContextMessages(compactedMessages),
        tools: activeSkill?.tools ? allTools : toolRegistry.getActiveSchemas(),
        stream: true,
      };

      if (thinkingEffort) {
        if (thinkingEffort === "off" || thinkingEffort === "none") {
          requestPayload.enable_thinking = false;
          requestPayload.think = false;
        } else if (["low", "medium", "high"].includes(thinkingEffort)) {
          requestPayload.enable_thinking = true;
          requestPayload.reasoning_effort = thinkingEffort;
          requestPayload.think = thinkingEffort;
        }
      }

      const stream = await llm.chat.completions.create(requestPayload);

      let fullContent = "";
      let inReasoningField = false;
      let inThinkTag = false;
      let thinkingBuffer = "";
      let thinkingStartTime = 0;
      let lastCommentaryUpdate = 0;
      let spinnerIdx = 0;
      const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

      const getThinkingStage = (elapsedMs: number, buffer: string): string => {
        const lower = buffer.toLowerCase().slice(-300);

        if (
          lower.includes("finally") ||
          lower.includes("in summary") ||
          lower.includes("conclusion") ||
          lower.includes("so the answer") ||
          lower.includes("now produce") ||
          lower.includes("final result") ||
          lower.includes("respond with")
        ) {
          return "Finalizing response";
        }

        if (
          lower.includes("check") ||
          lower.includes("verify") ||
          lower.includes("validate") ||
          lower.includes("ensure") ||
          lower.includes("confirm")
        ) {
          return "Validating solution";
        }

        if (
          lower.includes("step") ||
          lower.includes("order") ||
          lower.includes("structure") ||
          lower.includes("format") ||
          lower.includes("sequence")
        ) {
          return "Synthesizing steps";
        }

        if (elapsedMs > 18000) return "Finalizing logic";
        if (elapsedMs > 8000) return "Synthesizing solution";
        if (elapsedMs > 2500) return "Analyzing approach";
        return "Thinking";
      };

      const updateThinkingCommentary = (snippet: string) => {
        thinkingBuffer += snippet;
        const now = performance.now();
        if (now - lastCommentaryUpdate < 80) return;
        lastCommentaryUpdate = now;

        const elapsedMs = now - thinkingStartTime;
        const elapsedSec = (elapsedMs / 1000).toFixed(1);
        const stage = getThinkingStage(elapsedMs, thinkingBuffer);
        const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
        spinnerIdx++;

        process.stdout.write(
          `\r\x1b[2K  ${colors.boldCyan(frame)} ${colors.boldYellow(stage)} ${colors.gray(`(${elapsedSec}s)...`)}`,
        );
      };

      const finishThinking = () => {
        if (!thinkingStartTime) return;
        const totalSec = ((performance.now() - thinkingStartTime) / 1000).toFixed(1);
        thinkingStartTime = 0;
        process.stdout.write(
          `\r\x1b[2K  ${colors.dim("✨")} ${colors.gray(`Thought for ${totalSec}s`)}\n\n`,
        );
      };

      const toolCallsMap = new Map<
        number,
        { id?: string; name: string; args: string }
      >();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as any;
        if (!delta) continue;

        const reasoningChunk =
          delta.reasoning_content || delta.reasoning || delta.thinking || "";

        if (delta.content || delta.tool_calls || reasoningChunk) {
          if (!firstTokenTime) firstTokenTime = performance.now();
        }

        // 1. Handle dedicated reasoning_content chunk
        if (reasoningChunk) {
          if (!inReasoningField) {
            inReasoningField = true;
            thinkingStartTime = performance.now();
            thinkingBuffer = "";
          }
          updateThinkingCommentary(reasoningChunk);
        }

        // 2. Handle content chunk
        if (delta.content) {
          if (inReasoningField) {
            inReasoningField = false;
            finishThinking();
          }

          let text = delta.content;

          // Check if <think> tag opened in content
          if (text.includes("<think>")) {
            inThinkTag = true;
            thinkingStartTime = performance.now();
            thinkingBuffer = "";
            const parts = text.split("<think>");
            if (parts[0] && onToken) onToken(parts[0]);
            text = parts[1] ?? "";
          }

          // If currently inside <think> block
          if (inThinkTag) {
            if (text.includes("</think>")) {
              const parts = text.split("</think>");
              updateThinkingCommentary(parts[0] ?? "");
              inThinkTag = false;
              finishThinking();
              text = parts[1] ?? "";
            } else {
              updateThinkingCommentary(text);
              continue;
            }
          }

          fullContent += delta.content;
          if (text) {
            eventBus.emit({
              type: "token.streamed",
              sessionId,
              token: text,
              isReasoning: inReasoningField || inThinkTag,
              timestamp: new Date().toISOString(),
            });
          }
          if (onToken && text) {
            const trimmed = fullContent.trimStart();
            const isJsonToolCall =
              trimmed.startsWith("{") ||
              trimmed.startsWith("```json") ||
              trimmed.startsWith('"Read"') ||
              trimmed.startsWith('"Write"') ||
              trimmed.startsWith('"Bash"') ||
              trimmed.startsWith('"WebSearch"') ||
              trimmed.startsWith('"GetTime"') ||
              trimmed.startsWith('"get_time"') ||
              trimmed.startsWith('"LSP_') ||
              trimmed.startsWith('["');
            if (!isJsonToolCall) {
              onToken(text);
            }
          }
        }

        if (delta.tool_calls) {
          finishThinking();
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallsMap.get(idx) ?? {
              id: tc.id,
              name: "",
              args: "",
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
            toolCallsMap.set(idx, existing);
          }
        }
      }

      finishThinking();

      // Convert tool calls map to array
      let toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
        id: tc.id || "call_" + Math.random().toString(36).slice(2, 9),
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.args,
        },
      }));

      // Fallback extraction for local models that output tool JSON into content
      if (toolCalls.length === 0 && fullContent) {
        const tc = extractEmbeddedToolCall(fullContent, allToolNames);
        if (tc) {
          toolCalls = [tc];
        }
      }

      // Final response check
      if (toolCalls.length === 0) {
        const turnEnd = performance.now();
        const ttft_ms = firstTokenTime
          ? Math.round(firstTokenTime - turnStart)
          : Math.round(turnEnd - turnStart);
        const generation_time_ms = firstTokenTime
          ? Math.round(turnEnd - firstTokenTime)
          : 0;
        const output_tokens = estimateTokens(fullContent);
        const input_tokens = estimateMessagesTokens(messages);
        const context_tokens = input_tokens + output_tokens;
        const genSec = generation_time_ms / 1000;
        const tokens_per_second =
          genSec > 0 ? Math.round((output_tokens / genSec) * 10) / 10 : 0;

        recordTurnTelemetry({
          session_id: sessionId,
          turn: turns,
          model: model,
          input_tokens,
          output_tokens,
          context_tokens,
          model_context_limit: modelStats.modelContextLength,
          configured_context_limit: modelStats.configuredContextLength,
          ttft_ms,
          generation_time_ms,
          tokens_per_second,
          tool_calls: 0,
          tool_time_ms: 0,
          errors: 0,
          timestamp: new Date().toISOString(),
        });

        const cleaned = cleanAssistantContent(fullContent);
        const rawFinal =
          cleaned ||
          (actionLog.length > 0
            ? `✅ Completed:\n${actionLog.map((a) => `  • ${a}`).join("\n")}`
            : "✅ Done.");
        const finalContent = sanitizeSecrets(rawFinal);
        const finalMsg = { role: "assistant", content: finalContent };
        messages.push(finalMsg as any);
        if (sessionFilePath) appendSessionMessage(sessionFilePath, finalMsg);
        if (onToken) onToken("\n");
        return finalContent;
      }

      // Record assistant turn in history
      const assistantMsg = {
        role: "assistant",
        content: fullContent ? cleanAssistantContent(fullContent) : null,
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg as any);
      if (sessionFilePath) appendSessionMessage(sessionFilePath, assistantMsg);

      // Execute tool calls
      for (const tc of toolCalls) {
        const args = parseToolArguments(tc.function?.arguments);
        let toolName: string = tc.function?.name ?? "Unknown";
        const filePath = resolveFilePath(args.file_path);

        // Resolve MCP tool by prefix or local name
        let isMcp = toolName.startsWith("mcp__");
        let mcpMatch: { serverId: string; localName: string } | null = null;
        if (isMcp) {
          const [, serverId, ...rest] = toolName.split("__");
          mcpMatch = { serverId, localName: rest.join("__") };
        } else {
          for (const [sId, client] of mcpClients) {
            for (const t of client.getTools()) {
              const local = t.function.name.replace(/^mcp__[^_]+__/, "");
              if (
                local.toLowerCase() === toolName.toLowerCase() ||
                t.function.name.toLowerCase() === toolName.toLowerCase()
              ) {
                mcpMatch = { serverId: sId, localName: local };
                toolName = t.function.name;
                isMcp = true;
                break;
              }
            }
            if (mcpMatch) break;
          }
        }

        const summary =
          toolName === "Read"
            ? `📖 Reading  ${filePath}`
            : toolName === "Write"
              ? `📝 Writing  ${filePath}`
              : toolName === "Edit"
                ? `✏️ Editing  ${filePath}`
                : toolName === "Glob"
                  ? `🔎 Glob: "${args.pattern ?? ""}"`
                  : toolName === "Grep"
                    ? `🔍 Grep: "${args.query ?? ""}" in ${args.path ?? "."}`
                    : toolName === "Find"
                      ? `📂 Find: "${args.name ?? ""}"`
                      : toolName === "Tree"
                        ? `🌲 Tree: ${args.path ?? "."}`
                        : toolName === "Inspect"
                          ? `🔬 Inspecting: ${args.target ?? "project"}`
                          : toolName === "ToolSearch"
                            ? `🔎 Searching Tools: "${args.query ?? ""}"`
                            : toolName === "ToolsAvailable"
                              ? `🧰 Available Tools`
                              : toolName === "ExtractSymbols"
                                ? `📑 Extracting Symbols: ${filePath}`
                                : toolName === "SummarizeFile"
                                  ? `🗜️ Summarizing File: ${filePath}`
                                  : toolName === "ContextExtract"
                                    ? `🎯 Context Window: ${filePath} (around "${args.query ?? ""}")`
                                    : toolName === "SummarizeDiff"
                                      ? `📊 Summarizing Diff: ${args.file_path ?? "all"}`
                                      : toolName === "WebSearch"
                                        ? `🌐 Searching: "${args.query ?? ""}"`
                                      : toolName === "LSP_Definition"
                                        ? `🔍 LSP Definition: ${args.symbol ?? filePath}`
                                        : toolName === "LSP_References"
                                          ? `🔎 LSP References: ${args.symbol ?? filePath}`
                                          : toolName === "LSP_DocumentSymbols"
                                            ? `📑 LSP Symbols: ${filePath}`
                                            : toolName === "LSP_Hover"
                                              ? `ℹ️ LSP Hover: ${args.symbol ?? filePath}`
                                              : isMcp && mcpMatch
                                                ? `🔌 MCP: ${mcpMatch.localName}`
                                                : `⚡ Running: ${args.command ?? ""}`;

        // Target resource for permission evaluation
        const target =
          toolName === "Bash"
            ? String(args.command ?? "")
            : toolName === "WebSearch"
              ? String(args.query ?? "")
              : toolName === "Glob"
                ? String(args.pattern ?? "")
                : toolName === "Grep"
                  ? String(args.query ?? "")
                  : toolName === "Find"
                    ? String(args.name ?? "")
                    : toolName === "Tree"
                      ? String(args.path ?? ".")
                      : toolName === "Inspect"
                        ? String(args.target ?? "project")
                        : toolName === "ToolSearch"
                          ? String(args.query ?? "")
                          : toolName === "ToolsAvailable"
                            ? String(args.category ?? "all")
                            : toolName === "ExtractSymbols" ||
                                toolName === "SummarizeFile" ||
                                toolName === "ContextExtract"
                              ? filePath
                              : toolName === "SummarizeDiff"
                                ? String(args.file_path ?? "diff")
                                : toolName.startsWith("LSP_")
                                  ? String(args.symbol ?? filePath)
                                  : isMcp && mcpMatch
                                    ? mcpMatch.localName
                                    : filePath;

        // Evaluate permissions
        const { action, rule } = evaluatePermission(
          toolName,
          target,
          permConfig,
          runtimePermCache,
        );
        let result: string | null = null;

        eventBus.emit({
          type: "permission.requested",
          sessionId,
          toolName,
          target,
          action,
          timestamp: new Date().toISOString(),
        });

        if (action === "deny") {
          process.stdout.write(
            `  ${colors.dim("↳")} ${colors.red(`[⛔ Denied by policy]`)} ${toolName}: ${target} (${rule?.description ?? "Restricted"})\n`,
          );
          result = `Error: Permission denied by policy for ${toolName}: "${target}". ${rule?.description ? `Reason: ${rule.description}` : ""}`;
        } else if (action === "ask") {
          const allowed = await promptUserPermission(
            toolName,
            summary,
            target,
            runtimePermCache,
          );
          if (!allowed) {
            process.stdout.write(
              `  ${colors.dim("↳")} ${colors.boldYellow(`[Declined by user]`)} ${toolName}\n`,
            );
            result = `Error: User denied permission to execute ${toolName} on "${target}".`;
          }
        }

        eventBus.emit({
          type: "permission.resolved",
          sessionId,
          toolName,
          target,
          allowed: !result,
          timestamp: new Date().toISOString(),
        });

        // Security Guardrail 1: Sensitive path protection
        if (
          !result &&
          (toolName === "Read" ||
            toolName === "Write" ||
            toolName === "Edit" ||
            toolName === "Tree" ||
            toolName.startsWith("LSP_"))
        ) {
          const pathCheck = validatePathSafety(filePath);
          if (!pathCheck.safe) {
            process.stdout.write(
              `  ${colors.dim("↳")} ${colors.red(`[⛔ Blocked by Guardrail]`)} ${toolName}: ${filePath} (${pathCheck.reason})\n`,
            );
            result = `Error: Security Guardrail: Access to "${filePath}" was blocked. ${pathCheck.reason}`;
          }
        }

        // Security Guardrail 2: Dangerous command blocking
        if (!result && toolName === "Bash") {
          const cmdCheck = validateCommandSafety(String(args.command ?? ""));
          if (!cmdCheck.safe) {
            process.stdout.write(
              `  ${colors.dim("↳")} ${colors.red(`[⛔ Blocked by Guardrail]`)} Bash: ${args.command} (${cmdCheck.reason})\n`,
            );
            result = `Error: Security Guardrail: Command "${args.command}" was blocked. ${cmdCheck.reason}`;
          }
        }

        // Security Guardrail 3: Repetitive tool loop prevention
        if (!result) {
          const loopCheck = loopDetector.check(toolName, args);
          if (loopCheck.isLooping) {
            process.stdout.write(
              `  ${colors.dim("↳")} ${colors.boldYellow(`[⚠️ Loop Guardrail Intercept]`)} ${toolName} repeated ${loopCheck.repeatCount} times\n`,
            );
            result = `Error: Guardrail: Detected repetitive tool loop (${loopCheck.repeatCount} identical calls to ${toolName}). Stop retrying and report the issue to the user.`;
          }
        }

        // Notify tool call if allowed
        if (!result) {
          eventBus.emit({
            type: "tool.started",
            sessionId,
            toolName,
            args,
            summary,
            target,
            timestamp: new Date().toISOString(),
          });

          if (notifyTool) {
            notifyTool(toolName, summary);
          } else {
            process.stdout.write(
              `  ${colors.dim("↳")} ${colors.boldCyan(`[${toolName}]`)} ${colors.gray(summary)}\n`,
            );
          }
        }

        // Trigger pre_tool_call lifecycle hooks (e.g. automatic backup)
        if (result === null) {
          await executeHooks(
            "pre_tool_call",
            { toolName, filePath, target, args },
            hooksConfig,
          );
        }

        const toolExecStart = performance.now();

        // Tool handlers (only execute if not blocked by permission)
        if (result !== null) {
          // Already rejected
        } else if (toolName === "Read") {
          try {
            result = fs.existsSync(filePath)
              ? fs.readFileSync(filePath, "utf-8")
              : `Error: file not found: ${filePath}`;
            if (!result.startsWith("Error:"))
              actionLog.push(`Read ${filePath}`);
          } catch (e: any) {
            result = `Error reading ${filePath}: ${e.message}`;
          }
        } else if (toolName === "Write") {
          try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, args.content ?? "", "utf-8");
            result = `Written: ${filePath}`;
            actionLog.push(`Wrote ${filePath}`);
          } catch (e: any) {
            result = `Error writing ${filePath}: ${e.message}`;
          }
        } else if (toolName === "Edit") {
          result = executeEdit(filePath, args);
          if (!result.startsWith("Error:")) actionLog.push(`Edited ${filePath}`);
        } else if (toolName === "Glob") {
          const pat = String(args.pattern ?? "");
          result = executeGlob(
            pat,
            args.path ? resolveFilePath(args.path) : process.cwd(),
          );
          if (!result.startsWith("Error:")) actionLog.push(`Glob: ${pat}`);
        } else if (toolName === "Grep") {
          const q = String(args.query ?? "");
          result = executeGrep(
            q,
            args.path ? resolveFilePath(args.path) : ".",
            args.include,
          );
          if (!result.startsWith("Error:")) actionLog.push(`Grep: "${q}"`);
        } else if (toolName === "Find") {
          const n = String(args.name ?? "");
          result = executeFind(
            n,
            args.path ? resolveFilePath(args.path) : ".",
          );
          if (!result.startsWith("Error:")) actionLog.push(`Find: ${n}`);
        } else if (toolName === "Tree") {
          result = executeTree(
            args.path ? resolveFilePath(args.path) : ".",
            Number(args.depth ?? 3),
          );
          if (!result.startsWith("Error:")) actionLog.push(`Tree: ${args.path ?? "."}`);
        } else if (toolName === "Inspect") {
          result = executeInspect(args);
          if (!result.startsWith("Error:"))
            actionLog.push(`Inspect ${args.target || "project"}`);
        } else if (toolName === "ToolSearch") {
          result = executeToolSearch(String(args.query ?? ""), args.category);
          if (!result.startsWith("Error:"))
            actionLog.push(`ToolSearch: ${args.query}`);
        } else if (toolName === "ToolsAvailable") {
          result = executeToolsAvailable(args.category);
          if (!result.startsWith("Error:")) actionLog.push(`ToolsAvailable`);
        } else if (toolName === "ExtractSymbols") {
          result = extractSymbols(filePath);
          if (!result.startsWith("Error:"))
            actionLog.push(`ExtractSymbols: ${filePath}`);
        } else if (toolName === "SummarizeFile") {
          result = summarizeFile(filePath);
          if (!result.startsWith("Error:"))
            actionLog.push(`SummarizeFile: ${filePath}`);
        } else if (toolName === "ContextExtract") {
          result = contextExtract(
            filePath,
            args.query,
            Number(args.radius ?? 15),
          );
          if (!result.startsWith("Error:"))
            actionLog.push(`ContextExtract: ${filePath}`);
        } else if (toolName === "SummarizeDiff") {
          result = summarizeDiff(args.file_path);
          if (!result.startsWith("Error:")) actionLog.push(`SummarizeDiff`);
        } else if (toolName === "Bash") {
          let command = args.command ?? "";
          if (typeof command === "object" && command !== null) {
            command =
              (command as any).command ??
              (command as any).cmd ??
              String(command);
          }
          try {
            result = await new Promise<string>((resolve) => {
              exec(String(command), (err, stdout, stderr) => {
                if (err) resolve(`Error: ${stderr || err.message}`);
                else resolve(stdout.trim() || "Command executed successfully.");
              });
            });
            actionLog.push(`Ran: ${command}`);
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
        } else if (toolName === "WebSearch") {
          const query = String(args.query ?? "").trim();
          try {
            const searchResults = await performWebSearch(query);
            result = formatSearchResults(query, searchResults);
            actionLog.push(`Web search: "${query}"`);
          } catch (e: any) {
            result = `Error executing web search: ${e.message}`;
          }
        } else if (toolName === "LSP_Definition") {
          try {
            const locs = await lspService.getDefinition(
              filePath,
              Number(args.line ?? 1),
              Number(args.character ?? 1),
              args.symbol,
            );
            result =
              locs.length > 0
                ? `Definition(s) found:\n${locs.map((l) => `  • ${l.filePath}:${l.line}:${l.character} -> "${l.preview}"`).join("\n")}`
                : `No definition found for "${args.symbol || filePath}".`;
            actionLog.push(`LSP Definition: ${args.symbol || filePath}`);
          } catch (e: any) {
            result = `Error fetching definition: ${e.message}`;
          }
        } else if (toolName === "LSP_References") {
          try {
            const refs = await lspService.getReferences(
              filePath,
              Number(args.line ?? 1),
              Number(args.character ?? 1),
              args.symbol,
            );
            result =
              refs.length > 0
                ? `Reference(s) found (${refs.length}):\n${refs.slice(0, 20).map((r) => `  • ${r.filePath}:${r.line}:${r.character} -> "${r.lineContent}"`).join("\n")}`
                : `No references found for "${args.symbol || filePath}".`;
            actionLog.push(`LSP References: ${args.symbol || filePath}`);
          } catch (e: any) {
            result = `Error fetching references: ${e.message}`;
          }
        } else if (toolName === "LSP_DocumentSymbols") {
          try {
            const syms = await lspService.getDocumentSymbols(filePath);
            result =
              syms.length > 0
                ? `Document symbols for ${filePath} (${syms.length}):\n${syms.map((s) => `  • [${s.kind}] ${s.name} (L${s.line}) -> "${s.preview}"`).join("\n")}`
                : `No symbols found in ${filePath}.`;
            actionLog.push(`LSP Symbols: ${filePath}`);
          } catch (e: any) {
            result = `Error fetching document symbols: ${e.message}`;
          }
        } else if (toolName === "LSP_Hover") {
          try {
            result = await lspService.getHover(
              filePath,
              Number(args.line ?? 1),
              Number(args.character ?? 1),
              args.symbol,
            );
            actionLog.push(`LSP Hover: ${args.symbol || filePath}`);
          } catch (e: any) {
            result = `Error fetching hover information: ${e.message}`;
          }
        } else if (isMcp && mcpMatch) {
          const mcpClient = mcpClients.get(mcpMatch.serverId);
          if (!mcpClient) {
            result = `Error: no MCP server with id "${mcpMatch.serverId}"`;
          } else {
            try {
              result = await mcpClient.callTool(mcpMatch.localName, args);
              actionLog.push(`MCP[${mcpMatch.serverId}] ${mcpMatch.localName}`);
            } catch (e: any) {
              result = `Error calling ${mcpMatch.localName}: ${e.message}`;
            }
          }
        } else {
          result = `Unknown tool: ${toolName}`;
        }

        const toolExecDuration = Math.round(performance.now() - toolExecStart);
        turnToolTimeMs += toolExecDuration;
        const isError = Boolean(
          result &&
            (result.startsWith("Error:") ||
              result.startsWith("Error reading") ||
              result.startsWith("Error writing")),
        );
        if (isError) {
          turnErrors++;
        }

        // Emit tool.completed event
        eventBus.emit({
          type: "tool.completed",
          sessionId,
          toolName,
          result: sanitizeSecrets(result ?? ""),
          executionTimeMs: toolExecDuration,
          isError,
          timestamp: new Date().toISOString(),
        });

        // Emit file.changed event if file modified
        if (!isError && (toolName === "Write" || toolName === "Edit")) {
          eventBus.emit({
            type: "file.changed",
            sessionId,
            filePath,
            action: toolName === "Write" ? "created" : "edited",
            operation: args.operation || "replace",
            timestamp: new Date().toISOString(),
          });
        }

        // Trigger post_tool_call lifecycle hooks
        await executeHooks(
          "post_tool_call",
          { toolName, filePath, target, args, result },
          hooksConfig,
        );

        // Record tool result
        const sanitizedResult = sanitizeSecrets(result ?? "");
        const toolMsg = {
          role: "tool",
          tool_call_id: tc.id,
          content: sanitizedResult,
        };
        messages.push(toolMsg);
        if (sessionFilePath) appendSessionMessage(sessionFilePath, toolMsg);
      }

      // Record telemetry for tool execution turn
      const turnEnd = performance.now();
      const ttft_ms = firstTokenTime
        ? Math.round(firstTokenTime - turnStart)
        : Math.round(turnEnd - turnStart);
      const generation_time_ms = firstTokenTime
        ? Math.round(turnEnd - firstTokenTime)
        : 0;
      const output_tokens =
        estimateTokens(fullContent) +
        estimateTokens(JSON.stringify(toolCalls));
      const input_tokens = estimateMessagesTokens(messages);
      const context_tokens = input_tokens + output_tokens;
      const genSec = generation_time_ms / 1000;
      const tokens_per_second =
        genSec > 0 ? Math.round((output_tokens / genSec) * 10) / 10 : 0;

      // Emit model.completed event
      eventBus.emit({
        type: "model.completed",
        sessionId,
        turn: turns,
        model,
        ttftMs: ttft_ms,
        generationTimeMs: generation_time_ms,
        tokensPerSecond: tokens_per_second,
        inputTokens: input_tokens,
        outputTokens: output_tokens,
        contextTokens: context_tokens,
        timestamp: new Date().toISOString(),
      });

      recordTurnTelemetry({
        session_id: sessionId,
        turn: turns,
        model: model,
        input_tokens,
        output_tokens,
        context_tokens,
        model_context_limit: modelStats.modelContextLength,
        configured_context_limit: modelStats.configuredContextLength,
        ttft_ms,
        generation_time_ms,
        tokens_per_second,
        tool_calls: toolCalls.length,
        tool_time_ms: Math.round(turnToolTimeMs),
        errors: turnErrors,
        timestamp: new Date().toISOString(),
      });
    }

    // Turn limit fallback
    const limitMsg =
      actionLog.length > 0
        ? `✅ Completed (turn limit reached):\n${actionLog.map((a) => `  • ${a}`).join("\n")}`
        : "⚠️ Turn limit reached without a final answer.";
    return limitMsg;
  } finally {
    // Emit session.ended event
    eventBus.emit({
      type: "session.ended",
      sessionId,
      model,
      totalTurns: turns,
      durationSec:
        Math.round(((performance.now() - sessionStartTime) / 1000) * 10) / 10,
      totalTokens: estimateMessagesTokens(messages),
      actionsCount: actionLog.length,
      errorsCount: 0,
      timestamp: new Date().toISOString(),
    });

    // Trigger on_session_end lifecycle hooks
    await executeHooks(
      "on_session_end",
      { actionLog, sessionId },
      hooksConfig,
    );

    // Cleanup MCP clients and LSP servers
    for (const c of mcpClients.values()) c.close();
    lspService.closeAll();
  }
}
