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
import { resolveModel } from "./models.ts";
import { lspService } from "./lsp-service.ts";
import { executeHooks, loadHooksConfig } from "./hooks.ts";
import {
  recordTurnTelemetry,
  estimateTokens,
  estimateMessagesTokens,
  fetchModelContextStats,
} from "./telemetry.ts";

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

// Clean assistant response
export function cleanAssistantContent(text: string): string {
  if (!text) return "";
  let clean = text.trim();

  // If model wrapped its final response in a JSON object: {"response": "..."} or {"name": "...", "arguments": {"response": "..."}}
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") {
      const inner = parsed.arguments ?? parsed;
      const val = inner.response || inner.answer || inner.output || inner.result || inner.message;
      if (val) return String(val);
    }
  } catch {
    const respMatch = clean.match(/"(?:response|answer|output|result|message)"\s*:\s*"([^"]+)/i);
    if (respMatch) {
      return respMatch[1];
    }
  }

  // Remove markdown codeblock JSON tool calls
  clean = clean.replace(/```(?:json)?\s*\{[\s\S]*?"(?:name|function|tool)"[\s\S]*?\}\s*```/gi, "");
  // Remove inline JSON tool call objects
  clean = clean.replace(/\{[^{}]*"(?:name|function|tool)"\s*:\s*"[^"]+"[^{}]*\}/g, "");
  // Remove XML tool tags
  clean = clean.replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "");
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
];

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

// Core agent loop
export async function runAgentMode(
  prompt: string,
  messages: any[],
  sessionFilePath?: string,
  mode: ExecutionMode = "cli",
  notifyTool?: (toolName: string, summary: string) => void,
  onToken?: (token: string) => void,
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
Use tools to answer requests (Read, Write, Bash, WebSearch, LSP_Definition, LSP_References, LSP_DocumentSymbols, LSP_Hover).
- When navigating code, finding where symbols/functions are defined, or locating usages across the project, use LSP tools (LSP_Definition, LSP_References, LSP_DocumentSymbols, LSP_Hover).
- When a file path is mentioned, immediately invoke Read — never ask the user to provide file paths or contents.
- When asked about real-time events, latest library documentation, current packages, or external web queries, use WebSearch to find up-to-date facts.${mcpList}${skillList}${activeSkillPrompt}
- IMPORTANT: When a tool returns a result (e.g. current time, directory listing, file contents, code definition), immediately present that answer in natural language to the user. Do NOT call the same tool again.
- Never output raw JSON tool calls in your final response.`,
    });
  }

  // User message
  messages.push({ role: "user", content: prompt });
  if (sessionFilePath)
    appendSessionMessage(sessionFilePath, { role: "user", content: prompt });

  const actionLog: string[] = [];
  const MAX_TURNS = 8;
  let turns = 0;

  // Load permission and hooks configuration
  const permConfig = loadPermissionConfig();
  const runtimePermCache = new Map<string, PermissionAction>();
  const hooksConfig = loadHooksConfig();
  const sessionId = sessionFilePath
    ? path.basename(sessionFilePath, ".jsonl")
    : "session_" + Date.now().toString(36);
  const modelStats = await fetchModelContextStats(model);

  try {
    while (turns++ < MAX_TURNS) {
      const turnStart = performance.now();
      let firstTokenTime = 0;
      let turnToolTimeMs = 0;
      let turnErrors = 0;

      const stream = await llm.chat.completions.create({
        model,
        messages: trimContextMessages(messages),
        tools: allTools,
        stream: true,
      });

      let fullContent = "";
      const toolCallsMap = new Map<
        number,
        { id?: string; name: string; args: string }
      >();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content || delta.tool_calls) {
          if (!firstTokenTime) firstTokenTime = performance.now();
        }

        if (delta.content) {
          fullContent += delta.content;
          if (onToken) {
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
              onToken(delta.content);
            }
          }
        }

        if (delta.tool_calls) {
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
        const finalContent =
          cleaned ||
          (actionLog.length > 0
            ? `✅ Completed:\n${actionLog.map((a) => `  • ${a}`).join("\n")}`
            : "✅ Done.");
        const finalMsg = { role: "assistant", content: finalContent };
        messages.push(finalMsg as any);
        if (sessionFilePath) appendSessionMessage(sessionFilePath, finalMsg);
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

        // Notify tool call if allowed
        if (!result) {
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

        turnToolTimeMs += performance.now() - toolExecStart;
        if (
          result &&
          (result.startsWith("Error:") ||
            result.startsWith("Error reading") ||
            result.startsWith("Error writing"))
        ) {
          turnErrors++;
        }

        // Trigger post_tool_call lifecycle hooks
        await executeHooks(
          "post_tool_call",
          { toolName, filePath, target, args, result },
          hooksConfig,
        );

        // Record tool result
        const toolMsg = { role: "tool", tool_call_id: tc.id, content: result };
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
