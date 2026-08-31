import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { exec } from "node:child_process";

// ---------------------------------------------------------------------------
// ANSI terminal styling helpers (no external deps)
// ---------------------------------------------------------------------------
const colors = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// File-path resolution
// Strips common LLM placeholder prefixes like /path/to/, path/to/your/, etc.
// so the model can say "hello.txt" or "/path/to/hello.txt" and both work.
// ---------------------------------------------------------------------------
const PLACEHOLDER_RE =
  /^(?:[/\\])?(?:(?:path|your)[/\\]to[/\\](?:your[/\\])?|your[/\\]project[/\\])/i;

function resolveFilePath(raw: any): string {
  if (!raw) return "";

  // Handle nested objects { file_path: "..." }
  let filePath: string =
    typeof raw === "object" && raw !== null
      ? String(raw.file_path ?? raw.path ?? raw.name ?? "")
      : String(raw);

  filePath = filePath.trim();
  if (!filePath) return "";

  // 1. Exact match
  if (fs.existsSync(filePath)) return filePath;

  // 2. Strip leading slashes and try relative
  const relative = filePath.replace(/^[/\\]+/, "");
  if (relative && fs.existsSync(relative)) return path.resolve(process.cwd(), relative);

  // 3. Strip LLM placeholder prefixes (/path/to/, your/project/, …)
  const stripped = filePath.replace(PLACEHOLDER_RE, "");
  if (stripped && stripped !== filePath) {
    if (fs.existsSync(stripped)) return path.resolve(process.cwd(), stripped);
    const strippedRel = stripped.replace(/^[/\\]+/, "");
    if (strippedRel && fs.existsSync(strippedRel))
      return path.resolve(process.cwd(), strippedRel);
  }

  // 4. Try just the basename in cwd
  const base = path.basename(filePath);
  if (base && fs.existsSync(base)) return path.resolve(process.cwd(), base);

  // 5. Fall back: resolve against cwd (Write will create the file)
  return path.resolve(process.cwd(), stripped || relative || filePath);
}

// ---------------------------------------------------------------------------
// Tool-argument parsing
// ---------------------------------------------------------------------------
function parseToolArguments(raw: any): Record<string, any> {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return { file_path: trimmed, command: trimmed };
      }
      try {
        // Attempt loose-JSON fix: single quotes → double, bare keys quoted
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

// ---------------------------------------------------------------------------
// Embedded tool-call extractor
// Handles every format local models (Qwen, Ollama) emit:
//   { "function": "Write", "arguments": {...} }   ← Qwen primary
//   { "name": "Write", "arguments": {...} }        ← standard / Claude
//   { name: Write, arguments: {...} }              ← bare-word Qwen
//   ```json { "name": "Write", ... } ```           ← code-block wrapped
// ---------------------------------------------------------------------------
function extractEmbeddedToolCall(content: string): any | null {
  // Candidates to try: code-block first, then raw inline JSON objects
  const candidates: string[] = [];

  // 1. Extract from ```(json)? ... ``` code blocks
  const codeBlock = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let m: RegExpExecArray | null;
  while ((m = codeBlock.exec(content)) !== null) candidates.push(m[1]);

  // 2. Extract all top-level balanced JSON objects from raw text
  let depth = 0, start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{") { if (depth++ === 0) start = i; }
    else if (content[i] === "}" && depth > 0) {
      if (--depth === 0 && start !== -1) {
        candidates.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const TOOL_NAMES = new Set(["Read", "Write", "Bash"]);

  for (const raw of candidates) {
    let parsed: any = null;

    // Try strict JSON first
    try { parsed = JSON.parse(raw); } catch { /* fall through */ }

    // Fix bare-word keys/values: name: Write → "name": "Write"
    if (!parsed) {
      try {
        const fixed = raw
          .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
          .replace(/:\s*([A-Za-z][A-Za-z0-9_]*)(?=[,}\s])/g, ': "$1"');
        parsed = JSON.parse(fixed);
      } catch { continue; }
    }

    if (!parsed || typeof parsed !== "object") continue;

    // Resolve tool name from any of the known keys
    const toolName: string =
      parsed.name ?? parsed.function ?? parsed.tool ?? "";
    const toolArgs = parsed.arguments ?? parsed.parameters ?? parsed.args ?? null;

    if (!TOOL_NAMES.has(toolName) || !toolArgs) continue;

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

  return null;
}

// ---------------------------------------------------------------------------
// Response cleaning
// Removes tool-call JSON blobs, Qwen XML tags, and other model artifacts
// from the final assistant message shown to the user.
// ---------------------------------------------------------------------------
// Regex that matches a JSON object containing any of the tool-call key patterns
// Qwen emits: { "function": "Write", "arguments": {...} }
// Standard:   { "name": "Write", "arguments": {...} }
const TOOL_CALL_OBJ_RE =
  /\{[^{}]*"(?:name|function|tool)"\s*:\s*"[A-Za-z][A-Za-z0-9_]*"[\s\S]*?\}/g;

function cleanAssistantContent(text: string): string {
  if (!text) return "";
  let clean = text.trim();

  // Strip ```(json)? { ... } ``` code-fenced tool call blocks
  clean = clean.replace(
    /```(?:json)?\s*\{[\s\S]*?\}\s*```\s*/gi,
    "",
  );
  // Strip any inline JSON object that looks like a tool call
  clean = clean.replace(TOOL_CALL_OBJ_RE, "");
  // Strip Qwen XML artifacts
  clean = clean.replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "");
  clean = clean.replace(/<[^>]+>/g, "").trim();

  // Strip stray punctuation left after JSON removal
  clean = clean.replace(/^[\s,;.!}]+|[\s,;{}]+$/g, "").trim();

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

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------
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
  error?: { code: number; message: string; data?: any };
};

// ---------------------------------------------------------------------------
// Session persistence helpers
// ---------------------------------------------------------------------------
const SESSION_DIR = path.resolve(process.cwd(), ".agents", "sessions");
const MAX_CONTEXT_MESSAGES = 20;

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function createNewSessionPath(): string {
  ensureSessionDir();
  return path.join(SESSION_DIR, `session_${Date.now()}.jsonl`);
}

function appendSessionMessage(sessionFilePath: string, message: any) {
  ensureSessionDir();
  fs.appendFileSync(sessionFilePath, JSON.stringify(message) + "\n", { encoding: "utf-8" });
}

function getLatestSessionFile(): string | null {
  ensureSessionDir();
  const files = fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ p: path.join(SESSION_DIR, f), mtime: fs.statSync(path.join(SESSION_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].p : null;
}

function loadSessionMessages(sessionFilePath: string): any[] {
  if (!fs.existsSync(sessionFilePath)) return [];
  return fs
    .readFileSync(sessionFilePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
}

function getSessionFileByID(sessionId: string): string {
  ensureSessionDir();
  const fullPath = path.join(SESSION_DIR, `${sessionId.replace(/\.jsonl$/, "")}.jsonl`);
  return fs.existsSync(fullPath) ? fullPath : "";
}

function listAllSessions(): Array<{
  id: string; createdAt: string; updatedAt: string; messageCount: number; title: string;
}> {
  ensureSessionDir();
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fullPath = path.join(SESSION_DIR, f);
      const stat = fs.statSync(fullPath);
      const messages = loadSessionMessages(fullPath);
      const lastUser = messages.filter((m) => m.role === "user").at(-1);
      return {
        id: f.replace(/\.jsonl$/, ""),
        createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        messageCount: messages.length,
        title: (lastUser?.content as string | undefined)?.slice(0, 50) ?? "Empty Session",
      };
    })
    .filter((s) => s.messageCount > 0)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function deleteSessionById(sessionId: string): boolean {
  const target = getSessionFileByID(sessionId);
  if (target) { fs.unlinkSync(target); return true; }
  return false;
}

function trimContextMessages(messages: any[]): any[] {
  if (messages.length <= MAX_CONTEXT_MESSAGES) return messages;
  const sys = messages.find((m) => m.role === "system");
  const recent = messages.slice(-(MAX_CONTEXT_MESSAGES - 1));
  return sys ? [sys, ...recent] : recent;
}

// ---------------------------------------------------------------------------
// Tool definitions (shared across all modes)
// ---------------------------------------------------------------------------
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
              "Relative or absolute path to the file. Use the real filename, NOT placeholder paths like /path/to/file.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file, creating it (and any parent directories) if it does not exist.",
      parameters: {
        type: "object",
        required: ["file_path", "content"],
        properties: {
          file_path: {
            type: "string",
            description: "Relative or absolute path where the file should be written.",
          },
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
];

// ---------------------------------------------------------------------------
// Execution mode type
// ---------------------------------------------------------------------------
type ExecutionMode = "cli" | "server" | "repl";

// ---------------------------------------------------------------------------
// Core agentic loop
// ---------------------------------------------------------------------------
async function runAgentMode(
  prompt: string,
  messages: any[],
  sessionFilePath?: string,
  mode: ExecutionMode = "cli",
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  });
  const model = process.env.MODEL ?? "anthropic/claude-haiku-4.5";
  const agentName = process.env.AGENT_NAME ?? "an expert coding assistant";

  // Ensure system message is first
  if (messages.length === 0 || messages[0].role !== "system") {
    messages.unshift({
      role: "system",
      content: `You are ${agentName}, an autonomous coding assistant.
When asked to create, read, write, or run files/commands, always use the provided tools (Read, Write, Bash).
Use simple, direct filenames for file_path — never placeholder paths like /path/to/file.txt.
After using tools to complete a task, reply with a brief plain-text confirmation like "Done! I wrote hello.txt with a Hello World message." — do NOT output JSON, code blocks with tool calls, or suggestions to run more tools.
Never output raw JSON tool calls in your final reply.`,
    });
  }

  messages.push({ role: "user", content: prompt });
  if (sessionFilePath) appendSessionMessage(sessionFilePath, { role: "user", content: prompt });

  // Track tool actions for auto-generating a summary when the model returns empty content
  const actionLog: string[] = [];

  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages: trimContextMessages(messages),
      tools: TOOLS,
    });

    const message = response.choices[0].message;

    // Collect tool calls
    let toolCalls: any[] = message.tool_calls ?? [];

    // Fallback: extract a tool call embedded in text content (local/small models like Qwen)
    if (toolCalls.length === 0 && message.content) {
      const tc = extractEmbeddedToolCall(message.content);
      if (tc) toolCalls = [tc];
    }

    // No tool calls → final answer
    if (toolCalls.length === 0) {
      const cleaned = cleanAssistantContent(message.content ?? "");
      // When the model returns empty content after tool use, build a summary from what ran
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

    // Record assistant message with tool calls
    messages.push(message as any);
    if (sessionFilePath) appendSessionMessage(sessionFilePath, message);

    // Execute each tool call
    for (const tc of toolCalls) {
      const args = parseToolArguments(tc.function?.arguments);
      const toolName: string = tc.function?.name ?? "Unknown";

      // Build display summary
      const displayArgs = { ...args };
      if (displayArgs.content) displayArgs.content = `[${String(displayArgs.content).length} chars]`;
      const filePath = resolveFilePath(args.file_path);
      const summary =
        toolName === "Read"  ? `📖 Reading  ${filePath}`
        : toolName === "Write" ? `📝 Writing  ${filePath}`
        : `⚡ Running: ${args.command ?? ""}`;

      // Emit notification
      if (mode === "server") {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", method: "session/tool_call", params: { tool: toolName, summary, args: displayArgs } }) + "\n",
        );
      } else {
        process.stdout.write(`  ${colors.dim("↳")} ${colors.boldCyan(`[${toolName}]`)} ${colors.gray(summary)}\n`);
      }

      let result: string;

      if (toolName === "Read") {
        try {
          if (!fs.existsSync(filePath)) {
            result = `Error: file not found: ${filePath}`;
          } else {
            result = fs.readFileSync(filePath, "utf-8");
            actionLog.push(`Read ${filePath}`);
          }
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
        // Normalize command: Qwen sometimes nests it as { command: { command: "..." } }
        let command = args.command ?? "";
        if (typeof command === "object" && command !== null) {
          command = command.command ?? command.cmd ?? String(command);
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
      } else {
        result = `Unknown tool: ${toolName}`;
      }

      const toolMsg = { role: "tool", tool_call_id: tc.id, content: result };
      messages.push(toolMsg);
      if (sessionFilePath) appendSessionMessage(sessionFilePath, toolMsg);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI single-prompt mode  (bun run app/main.ts -p "...")
// ---------------------------------------------------------------------------
async function runCliMode(prompt: string, options: { isContinue?: boolean; resumeId?: string }) {
  let sessionFile: string;
  let history: any[] = [];

  if (options.resumeId) {
    const target = getSessionFileByID(options.resumeId);
    if (!target) { process.stderr.write(`Error: session not found: ${options.resumeId}\n`); process.exit(1); }
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

// ---------------------------------------------------------------------------
// Interactive REPL mode  (bun run app/main.ts)
// ---------------------------------------------------------------------------
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
    currentSessionFile = latest ?? createNewSessionPath();
    history = latest ? loadSessionMessages(latest) : [];
  } else {
    currentSessionFile = createNewSessionPath();
  }

  const sessionId = () => path.basename(currentSessionFile, ".jsonl");

  console.log(
    "\n" + colors.boldCyan("╔═══════════════════════════════════════════════════════════╗") +
    "\n" + colors.boldCyan("║") + "           🤖 " + colors.bold("AI Coding Agent  (Interactive REPL)") + "           " + colors.boldCyan("║") +
    "\n" + colors.boldCyan("╚═══════════════════════════════════════════════════════════╝"),
  );
  console.log(colors.dim("  Type ") + colors.boldYellow("/help") + colors.dim(" for commands · ") + colors.boldYellow("/exit") + colors.dim(" to quit"));
  console.log(colors.dim(`  Session: `) + colors.green(sessionId()) + colors.dim(` · ${history.length} messages loaded\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => process.stdout.write(colors.boldGreen("you > "));
  ask();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { ask(); continue; }

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.split(/\s+/);

      switch (cmd) {
        case "/exit":
        case "/quit":
          console.log(colors.dim("Goodbye! 👋\n"));
          rl.close();
          process.exit(0);
          break;

        case "/help":
          console.log(
            "\n" + colors.bold("Slash commands:") +
            `\n  ${colors.boldYellow("/help")}             Show this menu` +
            `\n  ${colors.boldYellow("/clear")} | ${colors.boldYellow("/new")}     Start a fresh session` +
            `\n  ${colors.boldYellow("/sessions")} | ${colors.boldYellow("/list")} List saved sessions` +
            `\n  ${colors.boldYellow("/resume <id>")}    Resume an existing session` +
            `\n  ${colors.boldYellow("/exit")} | ${colors.boldYellow("/quit")}     Exit\n`,
          );
          break;

        case "/clear":
        case "/new":
          currentSessionFile = createNewSessionPath();
          history = [];
          console.log(colors.green(`✨ New session: ${sessionId()}\n`));
          break;

        case "/sessions":
        case "/list": {
          const sessions = listAllSessions();
          if (sessions.length === 0) {
            console.log(colors.gray("No saved sessions.\n"));
          } else {
            console.log("\n" + colors.bold("Saved Sessions:"));
            console.log(colors.gray("─".repeat(68)));
            for (const s of sessions) {
              const cur = s.id === sessionId();
              console.log(
                `${cur ? colors.boldGreen("▶ ") : "  "}${colors.cyan(s.id)}  ${colors.dim(String(s.messageCount) + " msgs")}  ${colors.italic(s.title)}`,
              );
            }
            console.log();
          }
          break;
        }

        case "/resume": {
          const id = rest[0];
          if (!id) { console.log(colors.red("Usage: /resume <sessionId>\n")); break; }
          const target = getSessionFileByID(id);
          if (!target) {
            console.log(colors.red(`❌ Session not found: ${id}\n`));
          } else {
            currentSessionFile = target;
            history = loadSessionMessages(target);
            console.log(colors.green(`🔄 Resumed ${id} · ${history.length} messages\n`));
          }
          break;
        }

        default:
          console.log(colors.red(`Unknown command: ${cmd}  (type /help)\n`));
      }

      ask();
      continue;
    }

    // Agent call
    try {
      process.stdout.write(colors.boldCyan("agent > "));
      const result = await runAgentMode(input, history, currentSessionFile, "repl");
      process.stdout.write(`\n${result}\n\n`);
    } catch (e: any) {
      process.stdout.write(`\n${colors.red(`Error: ${e.message}`)}\n\n`);
    }

    ask();
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 ACP server mode  (piped / --server)
// ---------------------------------------------------------------------------
async function runServerMode() {
  let currentSessionFile = createNewSessionPath();
  let sessionMessages: any[] = [];

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const send = (obj: JsonRpcResponse) => process.stdout.write(JSON.stringify(obj) + "\n");

  for await (const line of rl) {
    if (!line.trim()) continue;

    let req: JsonRpcRequest;
    try { req = JSON.parse(line); }
    catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    const id = req.id ?? null;

    switch (req.method) {
      case "initialize":
        send({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2026-08-30",
            agentInfo: { name: process.env.AGENT_NAME ?? "AI Coding Agent", version: "1.0.0" },
            capabilities: { tools: ["Read", "Write", "Bash"] },
          },
        });
        break;

      case "ping":
        send({ jsonrpc: "2.0", id, result: "pong" });
        break;

      case "session/new":
        currentSessionFile = createNewSessionPath();
        sessionMessages = [];
        send({ jsonrpc: "2.0", id, result: { sessionId: path.basename(currentSessionFile, ".jsonl") } });
        break;

      case "session/list":
        send({ jsonrpc: "2.0", id, result: { sessions: listAllSessions() } });
        break;

      case "session/resume": {
        const targetId = req.params?.sessionId;
        const target = getSessionFileByID(targetId);
        if (!target) {
          send({ jsonrpc: "2.0", id, error: { code: -32001, message: `Session not found: ${targetId}` } });
        } else {
          currentSessionFile = target;
          sessionMessages = loadSessionMessages(target);
          send({ jsonrpc: "2.0", id, result: { sessionId: targetId, messageCount: sessionMessages.length } });
        }
        break;
      }

      case "session/prompt": {
        const userPrompt: string = req.params?.prompt ?? "";
        try {
          const result = await runAgentMode(userPrompt, sessionMessages, currentSessionFile, "server");
          send({ jsonrpc: "2.0", id, result: { content: result } });
        } catch (e: any) {
          send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message ?? "Internal error" } });
        }
        break;
      }

      case "session/delete": {
        const targetId = req.params?.sessionId;
        if (deleteSessionById(targetId)) {
          send({ jsonrpc: "2.0", id, result: { deleted: true, sessionId: targetId } });
        } else {
          send({ jsonrpc: "2.0", id, error: { code: -32001, message: `Session not found: ${targetId}` } });
        }
        break;
      }

      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const isContinue = args.includes("--continue") || args.includes("-c");
  const resumeIdx = args.findIndex((a) => a === "--resume" || a === "-r");
  const resumeId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  // --list / -l
  if (args.includes("--list") || args.includes("-l")) {
    const sessions = listAllSessions();
    if (sessions.length === 0) { console.log("No saved sessions found."); return; }
    console.log("Saved Sessions:");
    console.log("─".repeat(68));
    for (const s of sessions) {
      console.log(`• ID: ${s.id} | ${s.messageCount} msgs | ${s.updatedAt}\n  Title: ${s.title}`);
    }
    return;
  }

  // --delete <id>
  const delIdx = args.findIndex((a) => a === "--delete");
  if (delIdx !== -1 && args[delIdx + 1]) {
    const id = args[delIdx + 1];
    console.log(deleteSessionById(id) ? `✅ Deleted session '${id}'.` : `❌ Session '${id}' not found.`);
    return;
  }

  // -p "prompt"  →  single-shot CLI
  const pIdx = args.indexOf("-p");
  if (pIdx !== -1 && args[pIdx + 1]) {
    await runCliMode(args[pIdx + 1], { isContinue, resumeId });
    return;
  }

  // Interactive REPL vs ACP server
  const isServer = args.includes("--server") || args.includes("-s");
  const isTTY = process.stdin.isTTY && !isServer && !process.env.CI;

  if (isTTY || args.includes("--interactive") || args.includes("-i")) {
    await runReplMode({ isContinue, resumeId });
  } else {
    await runServerMode();
  }
}

main();
