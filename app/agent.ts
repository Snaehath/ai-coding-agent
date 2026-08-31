import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { McpClient, type McpToolSchema } from "./mcp-client.ts";
import {
  appendSessionMessage,
  trimContextMessages,
} from "./session.ts";
import { loadAllSkills, matchSkill } from "./skills.ts";
import { performWebSearch, formatSearchResults } from "./web-search.ts";
import {
  loadPermissionConfig,
  evaluatePermission,
  promptUserPermission,
  type PermissionAction,
} from "./permissions.ts";

// Constants
const PLACEHOLDER_RE =
  /^(?:[/\\])?(?:(?:path|your)[/\\]to[/\\](?:your[/\\])?|your[/\\]project[/\\])/i;

const TOOL_CALL_OBJ_RE =
  /\{[^{}]*"(?:name|function|tool)"\s*:\s*"[^"]+"[^{}]*\}/g;

const MCP_CONFIG_PATH = path.resolve(process.cwd(), ".agents", "mcp.json");

// ANSI color helpers
const colors = {
  dim:        (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:       (s: string) => `\x1b[1m${s}\x1b[0m`,
  boldCyan:   (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  boldMagenta:(s: string) => `\x1b[1;35m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  gray:       (s: string) => `\x1b[90m${s}\x1b[0m`,
  red:        (s: string) => `\x1b[31m${s}\x1b[0m`,
  green:      (s: string) => `\x1b[32m${s}\x1b[0m`,
};

// Types
export type ExecutionMode = "cli" | "server" | "repl";

// Path resolution
export function resolveFilePath(raw: any): string {
  if (!raw) return "";

  let filePath: string =
    typeof raw === "object" && raw !== null
      ? String(raw.file_path ?? raw.path ?? raw.name ?? "")
      : String(raw);

  filePath = filePath.trim();
  // Strip Git Bash prefix
  filePath = filePath.replace(/^[A-Za-z]:[/\\]Program Files[/\\]Git[/\\]/i, "");
  filePath = filePath.replace(/^(?:explain|fix|test)\s+/i, "");
  if (!filePath) return "";

  if (fs.existsSync(filePath)) return filePath;

  const relative = filePath.replace(/^[/\\]+/, "");
  if (relative && fs.existsSync(relative)) return path.resolve(process.cwd(), relative);

  const stripped = filePath.replace(PLACEHOLDER_RE, "");
  if (stripped && stripped !== filePath) {
    if (fs.existsSync(stripped)) return path.resolve(process.cwd(), stripped);
    const strippedRel = stripped.replace(/^[/\\]+/, "");
    if (strippedRel && fs.existsSync(strippedRel))
      return path.resolve(process.cwd(), strippedRel);
  }

  const base = path.basename(filePath);
  if (base && fs.existsSync(base)) return path.resolve(process.cwd(), base);

  return path.resolve(process.cwd(), stripped || relative || filePath);
}

// Tool argument parsing
export function parseToolArguments(raw: any): Record<string, any> {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try { return JSON.parse(trimmed); } catch { /* fallback */ }
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return { file_path: trimmed, command: trimmed };
    }
    try {
      const fixed = trimmed
        .replace(/'/g, '"')
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
      return JSON.parse(fixed);
    } catch { return {}; }
  }
  return {};
}

// Extract embedded tool calls from text
export function extractEmbeddedToolCall(
  content: string,
  knownTools: Set<string> = new Set(["Read", "Write", "Bash", "WebSearch"]),
): any | null {
  const candidates: string[] = [];

  const codeBlock = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let m: RegExpExecArray | null;
  while ((m = codeBlock.exec(content)) !== null) candidates.push(m[1]);

  let depth = 0, start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{") { if (depth++ === 0) start = i; }
    else if (content[i] === "}" && depth > 0) {
      if (--depth === 0 && start !== -1) { candidates.push(content.slice(start, i + 1)); start = -1; }
    }
  }

  for (const raw of candidates) {
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* fallback */ }

    if (!parsed) {
      try {
        const fixed = raw
          .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
          .replace(/:\s*([A-Za-z][A-Za-z0-9_]*)(?=[,}\s])/g, ': "$1"');
        parsed = JSON.parse(fixed);
      } catch { continue; }
    }

    if (!parsed || typeof parsed !== "object") continue;

    const toolName: string = parsed.name ?? parsed.function ?? parsed.tool ?? "";
    const toolArgs = parsed.arguments ?? parsed.parameters ?? parsed.args ?? null;

    if (!knownTools.has(toolName) || !toolArgs) continue;

    return {
      id: "call_" + Math.random().toString(36).slice(2, 9),
      type: "function",
      function: {
        name: toolName,
        arguments: typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs),
      },
    };
  }

  // Check for tuple format fallback: "ToolName", { "arg": "value" ... }
  const tupleRegex = /["']?([A-Za-z0-9_]+)["']?\s*,\s*(\{[\s\S]*)/;
  const tupleMatch = content.match(tupleRegex);
  if (tupleMatch && knownTools.has(tupleMatch[1])) {
    const toolName = tupleMatch[1];
    let rawArgs = tupleMatch[2].trim();
    if (!rawArgs.endsWith("}")) rawArgs += "}";
    try {
      const parsedArgs = JSON.parse(rawArgs);
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
        return {
          id: "call_" + Math.random().toString(36).slice(2, 9),
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify(parsedArgs),
          },
        };
      } catch { /* fall through */ }
    }
  }

  return null;
}

// Clean assistant response
export function cleanAssistantContent(text: string): string {
  if (!text) return "";
  let clean = text.trim();
  clean = clean.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```\s*/gi, "");
  clean = clean.replace(TOOL_CALL_OBJ_RE, "");
  clean = clean.replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "");
  clean = clean.replace(/<[^>]+>/g, "").trim();
  clean = clean.replace(/^[\s,;.!}]+|[\s,;{}]+$/g, "").trim();
  if (!clean || clean === "{}" || clean === "}" || clean.includes("<none>") || clean.includes('"none"')) {
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
            description: "Relative or absolute path to the file. Use the real filename — NOT placeholder paths like /path/to/file.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file, creating it (and any parent directories) if needed.",
      parameters: {
        type: "object",
        required: ["file_path", "content"],
        properties: {
          file_path: { type: "string", description: "Path where the file should be written." },
          content: { type: "string", description: "The full content to write." },
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
          command: { type: "string", description: "The shell command to run." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebSearch",
      description: "Search the live web for real-time information, documentation, news, or external references.",
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
];

// Load MCP clients
async function loadMcpClients(): Promise<Map<string, McpClient>> {
  const clients = new Map<string, McpClient>();
  if (!fs.existsSync(MCP_CONFIG_PATH)) return clients;

  let config: { servers?: Array<{ id: string; command: string; args?: string[] }> };
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
      process.stderr.write(`[MCP] Failed to connect "${srv.id}": ${e.message}\n`);
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
  const model = process.env.MODEL ?? "anthropic/claude-haiku-4.5";
  const agentName = process.env.AGENT_NAME ?? "an expert coding assistant";

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
    allTools = allTools.filter((t) =>
      allowedSet.has(t.function.name) ||
      allowedSet.has(t.function.name.replace(/^mcp__[^_]+__/, "")),
    );
  }

  const allToolNames = new Set(["Read", "Write", "Bash", "WebSearch", ...allTools.map((t) => t.function.name)]);

  // Notify skill activation in terminal
  if (activeSkill) {
    process.stdout.write(
      `  ${colors.dim("↳")} ${colors.boldMagenta(`[Skill: ${activeSkill.name}]`)} ${colors.gray(activeSkill.description.slice(0, 70))}...\n`,
    );
  }

  // System prompt
  if (messages.length === 0 || messages[0].role !== "system") {
    const mcpList = mcpTools.length > 0
      ? `\nMCP tools available: ${mcpTools.map((t) => t.function.name.replace(/^mcp__[^_]+__/, "")).join(", ")}.`
      : "";
    const skillList = skills.length > 0
      ? `\nAvailable skills: ${skills.map((s) => s.name).join(", ")}.`
      : "";
    const activeSkillPrompt = activeSkill
      ? `\n\n--- ACTIVE SKILL: ${activeSkill.name} ---\n${activeSkill.instructions}\n----------------------------------`
      : "";

    messages.unshift({
      role: "system",
      content: `You are ${agentName}, an autonomous coding assistant.
Use tools to answer requests (Read, Write, Bash, WebSearch).
- When a file path is mentioned, immediately invoke Read — never ask the user to provide file paths or contents.
- When asked about real-time events, latest library documentation, current packages, or external web queries, use WebSearch to find up-to-date facts.${mcpList}${skillList}${activeSkillPrompt}
When a tool returns a result, summarize and present the findings clearly to the user. Do not call the same tool repeatedly.
Never output raw JSON tool calls in your final response.`,
    });
  }

  // User message
  messages.push({ role: "user", content: prompt });
  if (sessionFilePath) appendSessionMessage(sessionFilePath, { role: "user", content: prompt });

  const actionLog: string[] = [];
  const MAX_TURNS = 8;
  let turns = 0;

  // Load permission configuration and runtime session cache
  const permConfig = loadPermissionConfig();
  const runtimePermCache = new Map<string, PermissionAction>();

  try {
    while (turns++ < MAX_TURNS) {
      const stream = await llm.chat.completions.create({
        model,
        messages: trimContextMessages(messages),
        tools: allTools,
        stream: true,
      });

      let fullContent = "";
      const toolCallsMap = new Map<number, { id?: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          if (onToken) {
            onToken(delta.content);
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallsMap.get(idx) ?? { id: tc.id, name: "", args: "" };
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
        const toolName: string = tc.function?.name ?? "Unknown";
        const filePath = resolveFilePath(args.file_path);
        const isMcp = toolName.startsWith("mcp__");

        const summary =
          toolName === "Read"      ? `📖 Reading  ${filePath}`
          : toolName === "Write"   ? `📝 Writing  ${filePath}`
          : toolName === "WebSearch" ? `🌐 Searching: "${args.query ?? ""}"`
          : isMcp                   ? `🔌 MCP: ${toolName.replace(/^mcp__[^_]+__/, "")}`
          : `⚡ Running: ${args.command ?? ""}`;

        // Target resource for permission evaluation
        const target =
          toolName === "Bash" ? String(args.command ?? "")
          : toolName === "WebSearch" ? String(args.query ?? "")
          : isMcp ? toolName.split("__").slice(2).join("__")
          : filePath;

        // Evaluate permissions
        const { action, rule } = evaluatePermission(toolName, target, permConfig, runtimePermCache);
        let result: string | null = null;

        if (action === "deny") {
          process.stdout.write(`  ${colors.dim("↳")} ${colors.red(`[⛔ Denied by policy]`)} ${toolName}: ${target} (${rule?.description ?? "Restricted"})\n`);
          result = `Error: Permission denied by policy for ${toolName}: "${target}". ${rule?.description ? `Reason: ${rule.description}` : ""}`;
        } else if (action === "ask") {
          const allowed = await promptUserPermission(toolName, summary, target, runtimePermCache);
          if (!allowed) {
            process.stdout.write(`  ${colors.dim("↳")} ${colors.boldYellow(`[Declined by user]`)} ${toolName}\n`);
            result = `Error: User denied permission to execute ${toolName} on "${target}".`;
          }
        }

        // Notify tool call if allowed
        if (!result) {
          if (notifyTool) {
            notifyTool(toolName, summary);
          } else {
            process.stdout.write(`  ${colors.dim("↳")} ${colors.boldCyan(`[${toolName}]`)} ${colors.gray(summary)}\n`);
          }
        }

        // Tool handlers (only execute if not blocked by permission)
        if (result !== null) {
          // Already rejected
        } else if (toolName === "Read") {
          try {
            result = fs.existsSync(filePath)
              ? fs.readFileSync(filePath, "utf-8")
              : `Error: file not found: ${filePath}`;
            if (!result.startsWith("Error:")) actionLog.push(`Read ${filePath}`);
          } catch (e: any) { result = `Error reading ${filePath}: ${e.message}`; }

        } else if (toolName === "Write") {
          try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, args.content ?? "", "utf-8");
            result = `Written: ${filePath}`;
            actionLog.push(`Wrote ${filePath}`);
          } catch (e: any) { result = `Error writing ${filePath}: ${e.message}`; }

        } else if (toolName === "Bash") {
          let command = args.command ?? "";
          if (typeof command === "object" && command !== null) {
            command = (command as any).command ?? (command as any).cmd ?? String(command);
          }
          try {
            result = await new Promise<string>((resolve) => {
              exec(String(command), (err, stdout, stderr) => {
                if (err) resolve(`Error: ${stderr || err.message}`);
                else resolve(stdout.trim() || "Command executed successfully.");
              });
            });
            actionLog.push(`Ran: ${command}`);
          } catch (e: any) { result = `Error: ${e.message}`; }

        } else if (toolName === "WebSearch") {
          const query = String(args.query ?? "").trim();
          try {
            const searchResults = await performWebSearch(query);
            result = formatSearchResults(query, searchResults);
            actionLog.push(`Web search: "${query}"`);
          } catch (e: any) {
            result = `Error executing web search: ${e.message}`;
          }

        } else if (isMcp) {
          const [, serverId, ...rest] = toolName.split("__");
          const localName = rest.join("__");
          const mcpClient = mcpClients.get(serverId);
          if (!mcpClient) {
            result = `Error: no MCP server with id "${serverId}"`;
          } else {
            try {
              result = await mcpClient.callTool(localName, args);
              actionLog.push(`MCP[${serverId}] ${localName}`);
            } catch (e: any) { result = `Error calling ${localName}: ${e.message}`; }
          }

        } else {
          result = `Unknown tool: ${toolName}`;
        }

        // Record tool result
        const toolMsg = { role: "tool", tool_call_id: tc.id, content: result };
        messages.push(toolMsg);
        if (sessionFilePath) appendSessionMessage(sessionFilePath, toolMsg);
      }
    }

    // Turn limit fallback
    const limitMsg =
      actionLog.length > 0
        ? `✅ Completed (turn limit reached):\n${actionLog.map((a) => `  • ${a}`).join("\n")}`
        : "⚠️ Turn limit reached without a final answer.";
    return limitMsg;
  } finally {
    // Cleanup MCP clients
    for (const c of mcpClients.values()) c.close();
  }
}
