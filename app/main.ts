import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { exec } from "node:child_process";

// ANSI terminal styling helper
const colors = {
  reset: "\x1b[0m",
  bold: (str: string) => `\x1b[1m${str}\x1b[0m`,
  dim: (str: string) => `\x1b[2m${str}\x1b[0m`,
  italic: (str: string) => `\x1b[3m${str}\x1b[0m`,
  cyan: (str: string) => `\x1b[36m${str}\x1b[0m`,
  green: (str: string) => `\x1b[32m${str}\x1b[0m`,
  yellow: (str: string) => `\x1b[33m${str}\x1b[0m`,
  blue: (str: string) => `\x1b[34m${str}\x1b[0m`,
  magenta: (str: string) => `\x1b[35m${str}\x1b[0m`,
  gray: (str: string) => `\x1b[90m${str}\x1b[0m`,
  red: (str: string) => `\x1b[31m${str}\x1b[0m`,
  boldCyan: (str: string) => `\x1b[1;36m${str}\x1b[0m`,
  boldGreen: (str: string) => `\x1b[1;32m${str}\x1b[0m`,
  boldYellow: (str: string) => `\x1b[1;33m${str}\x1b[0m`,
  boldMagenta: (str: string) => `\x1b[1;35m${str}\x1b[0m`,
};

// resolve file path for local system
function resolveFilePath(filePath: string): string {
  if (!filePath) return "";
  if (fs.existsSync(filePath)) return filePath;
  const relativePath = filePath.replace(/^[/\\]+/, "");
  if (fs.existsSync(relativePath)) return relativePath;
  return path.resolve(process.cwd(), relativePath);
}

// safely parses tool arguments regardless of whether they are already an object,
// valid JSON, loose JSON, or single-quote strings.
function parseToolArguments(raw: any): Record<string, any> {
  if (typeof raw === "object" && raw !== null) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // If it's a simple path or text
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return { file_path: trimmed, command: trimmed };
      }
      try {
        const fixed = trimmed
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        return JSON.parse(fixed);
      } catch {
        return {};
      }
    }
  }
  return {};
}

// clean assistant content from tool call artifacts, Qwen internal XML tokens, and formats the final output cleanly.
function cleanAssistantContent(text: string): string {
  if (!text) return "";
  let clean = text.trim();

  // Strip markdown ```json { ... } ``` tool call blocks
  clean = clean.replace(
    /```(?:json)?\s*\{[\s\S]*?"name"[\s\S]*?\}\s*```\s*/gi,
    "",
  );
  // Strip raw JSON tool call blocks
  clean = clean.replace(/^\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}\s*/gi, "");
  // Strip Qwen internal XML tags like <tool_response>, <nil>, etc.
  clean = clean.replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "");
  clean = clean.replace(/<[^>]+>/g, "").trim();

  // If only Qwen <none> token or empty after cleaning
  if (!clean || clean.includes("<none>") || clean.includes('"none"')) {
    clean = "✅ Action completed successfully.";
  }

  return clean.trim();
}

// JSON-RPC 2.0 types
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
};

const SESSION_DIR = path.resolve(process.cwd(), ".agents", "sessions");
const MAX_CONTEXT_MESSAGES = 20;

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function createNewSessionPath(): string {
  ensureSessionDir();
  const sessionId = `session_${Date.now()}`;
  return path.join(SESSION_DIR, `${sessionId}.jsonl`);
}

function appendSessionMessage(sessionFilePath: string, message: any) {
  ensureSessionDir();
  fs.appendFileSync(sessionFilePath, JSON.stringify(message) + "\n", {
    encoding: "utf-8",
  });
}

function getLatestSessionFile(): string | null {
  ensureSessionDir();
  const files = fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      path: path.join(SESSION_DIR, f),
      mtime: fs.statSync(path.join(SESSION_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}

function loadSessionMessages(sessionFilePath: string): any[] {
  if (!fs.existsSync(sessionFilePath)) {
    return [];
  }
  const lines = fs.readFileSync(sessionFilePath, "utf-8").split("\n");
  const messages = [];
  for (const line of lines) {
    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines
      }
    }
  }
  return messages;
}

function getSessionFileByID(sessionId: string): string {
  ensureSessionDir();
  const baseName = sessionId.replace(/\.jsonl$/, "");
  const fullPath = path.join(SESSION_DIR, `${baseName}.jsonl`);
  return fs.existsSync(fullPath) ? fullPath : "";
}

function listAllSessions(): any[] {
  ensureSessionDir();
  const files = fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fullPath = path.join(SESSION_DIR, f);
      const stat = fs.statSync(fullPath);
      const messages = loadSessionMessages(fullPath);
      const lastUserMessage = messages.filter((m) => m.role === "user").at(-1);

      return {
        id: f.replace(/\.jsonl$/, ""),
        createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        messageCount: messages.length,
        title: lastUserMessage?.content?.slice(0, 45) ?? "Empty Session",
      };
    })
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

  return files;
}

function deleteSessionById(sessionId: string): boolean {
  const targetFile = getSessionFileByID(sessionId);
  if (targetFile && fs.existsSync(targetFile)) {
    fs.unlinkSync(targetFile);
    return true;
  }
  return false;
}

function trimContextMessages(messages: any[]): any[] {
  if (messages.length <= MAX_CONTEXT_MESSAGES) return messages;
  const systemMsg = messages.find((m) => m.role === "system");
  const recentMessages = messages.slice(-(MAX_CONTEXT_MESSAGES - 1));
  return systemMsg ? [systemMsg, ...recentMessages] : recentMessages;
}

export type ExecutionMode = "cli" | "server" | "repl";

// Core Agent Loop: handles tool calls and LLM reasoning
async function runAgentMode(
  prompt: string,
  messages: any[],
  sessionFilePath?: string,
  mode: ExecutionMode = "cli",
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const model = process.env.MODEL;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  // Ensure system prompt is present
  const agentName = process.env.AGENT_NAME ?? "an expert coding assistant";
  if (messages.length === 0 || messages[0].role !== "system") {
    messages.unshift({
      role: "system",
      content:
        `You are ${agentName}. Give direct, concise, and clean answers in Markdown. Do NOT include raw JSON tool calls in your final user response.`,
    });
  }

  // Add user prompt to session messages
  messages.push({ role: "user", content: prompt });
  if (sessionFilePath) {
    appendSessionMessage(sessionFilePath, { role: "user", content: prompt });
  }

  while (true) {
    const contextMessages = trimContextMessages(messages);

    const response = await client.chat.completions.create({
      model: model ?? "anthropic/claude-haiku-4.5",
      messages: contextMessages,
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read and return the content of a file",
            parameters: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
              required: ["file_path"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Write",
            description: "Write the content to a file",
            parameters: {
              type: "object",
              required: ["file_path", "content"],
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file to write",
                },
                content: {
                  type: "string",
                  description: "The content to write to the file",
                },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Execute a shell command",
            parameters: {
              type: "object",
              required: ["command"],
              properties: {
                command: {
                  type: "string",
                  description: "The shell command to execute",
                },
              },
            },
          },
        },
      ],
    });

    const message = response.choices[0].message;
    messages.push(message as any);

    if (sessionFilePath) {
      appendSessionMessage(sessionFilePath, message);
    }

    // 1. Collect native tool calls or parse from message.content
    let toolCalls: any[] = message.tool_calls ?? [];

    if (toolCalls.length === 0 && message.content) {
      const match =
        message.content.match(
          /```(?:json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/,
        ) ||
        message.content.match(/(\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\})/);

      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (
            parsed.name &&
            parsed.name !== "<none>" &&
            parsed.name !== "none" &&
            (parsed.arguments || parsed.parameters)
          ) {
            toolCalls = [
              {
                id: "call_" + Math.random().toString(36).substring(2, 9),
                type: "function",
                function: {
                  name: parsed.name,
                  arguments:
                    typeof parsed.arguments === "string"
                      ? parsed.arguments
                      : JSON.stringify(
                          parsed.arguments ?? parsed.parameters ?? {},
                        ),
                },
              },
            ];
          }
        } catch {
          // Not a JSON tool call, treat as normal text content
        }
      }
    }

    // 2. Exit loop if no tool calls are requested
    if (toolCalls.length === 0) {
      if (message.content) {
        return cleanAssistantContent(message.content);
      }
      break;
    }

    // 3. Process each tool call
    for (const toolCall of toolCalls) {
      const args = parseToolArguments(toolCall.function?.arguments);
      const cleanArgs = { ...args };

      if (cleanArgs.content) {
        cleanArgs.content = `[${cleanArgs.content.length} characters omitted]`;
      }

      const toolName = toolCall.function?.name ?? "Unknown";
      const summary =
        toolName === "Read"
          ? `📖 Reading ${cleanArgs.file_path ?? "file"}`
          : toolName === "Write"
            ? `📝 Writing ${cleanArgs.file_path ?? "file"}`
            : `⚡ Running: ${cleanArgs.command ?? ""}`;

      if (mode === "server") {
        const notification = {
          jsonrpc: "2.0",
          method: "session/tool_call",
          params: {
            tool: toolName,
            summary: summary,
            args: cleanArgs,
          },
        };
        process.stdout.write(JSON.stringify(notification) + "\n");
      } else {
        // REPL or CLI terminal presentation
        process.stdout.write(
          `  ${colors.dim("↳")} ${colors.boldCyan(`[Tool: ${toolName}]`)} ${colors.gray(summary)}\n`,
        );
      }

      // Execute tool call
      if (toolCall.function?.name === "Read") {
        const filePath = resolveFilePath(args.file_path);
        let fileContent: string;
        try {
          fileContent = fs.readFileSync(filePath, "utf-8");
        } catch (error: any) {
          fileContent = `Error reading file ${filePath}: ${error.message}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: fileContent,
        });

        if (sessionFilePath) {
          appendSessionMessage(sessionFilePath, {
            role: "tool",
            tool_call_id: toolCall.id,
            content: fileContent,
          });
        }
      }

      if (toolCall.function?.name === "Write") {
        const filePath = resolveFilePath(args.file_path);
        const content = args.content ?? "";
        let writeResult: string;
        try {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, content, "utf-8");
          writeResult = `File ${filePath} has been written successfully.`;
        } catch (error: any) {
          writeResult = `Error writing file ${filePath}: ${error.message}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: writeResult,
        });

        if (sessionFilePath) {
          appendSessionMessage(sessionFilePath, {
            role: "tool",
            tool_call_id: toolCall.id,
            content: writeResult,
          });
        }
      }

      if (toolCall.function?.name === "Bash") {
        const command = args.command;
        let bashResult: string;
        try {
          bashResult = await new Promise<string>((resolve) => {
            exec(command, (error: any, stdout: string, stderr: string) => {
              if (error) {
                resolve(`Error: ${stderr || error.message}`);
              } else {
                resolve(stdout);
              }
            });
          });
        } catch (error: any) {
          bashResult = `Error executing bash: ${error.message}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: bashResult,
        });

        if (sessionFilePath) {
          appendSessionMessage(sessionFilePath, {
            role: "tool",
            tool_call_id: toolCall.id,
            content: bashResult,
          });
        }
      }
    }
  }

  return "";
}

// Runs single-prompt CLI mode
async function runCliMode(
  prompt: string,
  options: { isContinue?: boolean; resumeId?: string },
) {
  let sessionFile: string;
  let history: any[] = [];

  if (options.resumeId) {
    const target = getSessionFileByID(options.resumeId);
    if (!target) {
      process.stderr.write(`Error: Session not found: ${options.resumeId}\n`);
      process.exit(1);
    }
    sessionFile = target;
    history = loadSessionMessages(target);
  } else if (options.isContinue) {
    const latest = getLatestSessionFile();
    sessionFile = latest ?? createNewSessionPath();
    history = latest ? loadSessionMessages(latest) : [];
  } else {
    sessionFile = createNewSessionPath();
  }

  const result = await runAgentMode(prompt, history, sessionFile, "cli");
  process.stdout.write(result + "\n");
}

// Runs interactive terminal REPL chat mode
async function runReplMode(options: { isContinue?: boolean; resumeId?: string }) {
  let currentSessionFile: string;
  let history: any[] = [];

  if (options.resumeId) {
    const target = getSessionFileByID(options.resumeId);
    if (!target) {
      console.log(colors.red(`❌ Session not found: ${options.resumeId}`));
      currentSessionFile = createNewSessionPath();
    } else {
      currentSessionFile = target;
      history = loadSessionMessages(target);
    }
  } else if (options.isContinue) {
    const latest = getLatestSessionFile();
    if (latest) {
      currentSessionFile = latest;
      history = loadSessionMessages(latest);
    } else {
      currentSessionFile = createNewSessionPath();
    }
  } else {
    currentSessionFile = createNewSessionPath();
  }

  const getSessionId = () => path.basename(currentSessionFile, ".jsonl");

  console.log("\n" + colors.boldCyan("╔═══════════════════════════════════════════════════════════╗"));
  console.log(colors.boldCyan("║") + "            🤖 " + colors.bold("AI Coding Agent (Interactive REPL)") + "           " + colors.boldCyan("║"));
  console.log(colors.boldCyan("╚═══════════════════════════════════════════════════════════╝"));
  console.log(colors.dim("Type ") + colors.boldYellow("/help") + colors.dim(" for slash commands, or ") + colors.boldYellow("/exit") + colors.dim(" to quit."));
  console.log(colors.dim(`Session: `) + colors.green(getSessionId()) + colors.dim(` (${history.length} messages loaded)\n`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: colors.boldGreen("you > "),
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // Slash command handling
    if (trimmed.startsWith("/")) {
      const [cmd, ...cmdArgs] = trimmed.split(" ");

      if (cmd === "/exit" || cmd === "/quit") {
        console.log(colors.dim("Goodbye! 👋\n"));
        rl.close();
        process.exit(0);
      }

      if (cmd === "/help") {
        console.log("\n" + colors.bold("Available Slash Commands:"));
        console.log(`  ${colors.boldYellow("/help")}            Show this help menu`);
        console.log(`  ${colors.boldYellow("/clear")} or ${colors.boldYellow("/new")}   Start a fresh session with new context`);
        console.log(`  ${colors.boldYellow("/sessions")} or ${colors.boldYellow("/list")} List all saved sessions`);
        console.log(`  ${colors.boldYellow("/resume <id>")}   Switch to and resume an existing session`);
        console.log(`  ${colors.boldYellow("/exit")} or ${colors.boldYellow("/quit")}   Exit the chat REPL\n`);
        rl.prompt();
        continue;
      }

      if (cmd === "/clear" || cmd === "/new") {
        currentSessionFile = createNewSessionPath();
        history = [];
        console.log(colors.green(`✨ Started new session: ${getSessionId()}\n`));
        rl.prompt();
        continue;
      }

      if (cmd === "/sessions" || cmd === "/list") {
        const sessions = listAllSessions();
        if (sessions.length === 0) {
          console.log(colors.gray("No saved sessions found.\n"));
        } else {
          console.log("\n" + colors.bold("Saved Sessions:"));
          console.log(colors.gray("----------------------------------------------------------------------"));
          for (const s of sessions) {
            const isCurrent = s.id === getSessionId();
            const prefix = isCurrent ? colors.boldGreen("▶ ") : "• ";
            console.log(
              `${prefix}ID: ${colors.cyan(s.id)} | Title: ${colors.italic(s.title)} | Msg: ${s.messageCount} | ${colors.gray(s.updatedAt)}`,
            );
          }
          console.log();
        }
        rl.prompt();
        continue;
      }

      if (cmd === "/resume") {
        const targetId = cmdArgs[0];
        if (!targetId) {
          console.log(colors.red("Usage: /resume <sessionId>\n"));
          rl.prompt();
          continue;
        }
        const targetFile = getSessionFileByID(targetId);
        if (!targetFile) {
          console.log(colors.red(`❌ Session not found: ${targetId}\n`));
        } else {
          currentSessionFile = targetFile;
          history = loadSessionMessages(targetFile);
          console.log(colors.green(`🔄 Resumed session: ${targetId} (${history.length} messages)\n`));
        }
        rl.prompt();
        continue;
      }

      console.log(colors.red(`Unknown command: ${cmd}. Type /help for available commands.\n`));
      rl.prompt();
      continue;
    }

    // Agent prompt execution
    try {
      process.stdout.write(colors.boldCyan("agent > "));
      const result = await runAgentMode(
        trimmed,
        history,
        currentSessionFile,
        "repl",
      );
      if (result) {
        process.stdout.write(`\n${result}\n\n`);
      } else {
        process.stdout.write("\n");
      }
    } catch (error: any) {
      process.stdout.write(`\n${colors.red(`Error: ${error.message}`)}\n\n`);
    }

    rl.prompt();
  }
}

// Runs JSON-RPC ACP server mode over stdio
async function runServerMode() {
  let currentSessionFile = createNewSessionPath();
  let sessionMessages: any[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      const parseError: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      };
      process.stdout.write(JSON.stringify(parseError) + "\n");
      continue;
    }

    if (request.method === "initialize") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          protocolVersion: "2026-08-30",
          agentInfo: {
            name: process.env.AGENT_NAME ?? "AI Coding Agent",
            version: "1.0.0",
          },
          capabilities: {
            tools: ["Read", "Write", "Bash"],
          },
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (request.method === "ping") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: "pong",
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (request.method === "session/list") {
      const sessions = listAllSessions();
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: { sessions },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (request.method === "session/new") {
      currentSessionFile = createNewSessionPath();
      sessionMessages = [];
      const sessionId = path.basename(currentSessionFile, ".jsonl");
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: { sessionId },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } else if (request.method === "session/resume") {
      const targetId = request.params?.sessionId;
      const targetFile = getSessionFileByID(targetId);
      if (!targetFile) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32001, message: `Session not found: ${targetId}` },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      } else {
        currentSessionFile = targetFile;
        sessionMessages = loadSessionMessages(targetFile);
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { sessionId: targetId, messageCount: sessionMessages.length },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } else if (request.method === "session/prompt") {
      const userPrompt = request.params?.prompt ?? "";
      try {
        const result = await runAgentMode(
          userPrompt,
          sessionMessages,
          currentSessionFile,
          "server",
        );
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { content: result },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (error: any) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code: -32000,
            message: error.message ?? "Internal error",
          },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    } else if (request.method === "session/delete") {
      const targetId = request.params?.sessionId;
      const success = deleteSessionById(targetId);
      if (success) {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { deleted: true, sessionId: targetId },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32001, message: `Session not found: ${targetId}` },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    } else {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32601,
          message: "Method not found",
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  }
}

// Main CLI router
async function main() {
  const args = process.argv.slice(2);
  const isContinue = args.includes("--continue") || args.includes("-c");

  const resumeIdx = args.findIndex((arg) => arg === "--resume" || arg === "-r");
  const resumeId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  // 1. Handle --list / -l
  if (args.includes("--list") || args.includes("-l")) {
    const sessions = listAllSessions();
    if (sessions.length === 0) {
      console.log("No saved sessions found in .agents/sessions/");
      return;
    }
    console.log("Saved Sessions:");
    console.log(
      "----------------------------------------------------------------------",
    );
    for (const s of sessions) {
      console.log(
        `• ID: ${s.id} | Title: ${s.title} | Messages: ${s.messageCount} | Updated: ${s.updatedAt}`,
      );
    }
    return;
  }

  // 2. Handle --delete <id>
  const deleteIdx = args.findIndex((a) => a === "--delete");
  if (deleteIdx !== -1 && args[deleteIdx + 1]) {
    const targetId = args[deleteIdx + 1];
    const success = deleteSessionById(targetId);
    if (success) {
      console.log(`✅ Session '${targetId}' deleted.`);
    } else {
      console.error(`❌ Session '${targetId}' not found.`);
    }
    return;
  }

  // 3. Handle single-prompt mode (-p "...")
  const pIndex = args.indexOf("-p");
  if (pIndex !== -1 && args[pIndex + 1]) {
    await runCliMode(args[pIndex + 1], { isContinue, resumeId });
    return;
  }

  // 4. Handle Server vs Interactive REPL mode
  const isExplicitServer = args.includes("--server") || args.includes("-s");
  const isInteractive =
    process.stdin.isTTY && !isExplicitServer && !process.env.CI;

  if (isInteractive || args.includes("--interactive") || args.includes("-i")) {
    await runReplMode({ isContinue, resumeId });
  } else {
    await runServerMode();
  }
}

main();
