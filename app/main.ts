import path from "node:path";
import * as readline from "node:readline";
import { runAgentMode, type ExecutionMode } from "./agent.ts";
import {
  createNewSessionPath,
  deleteSessionById,
  getLatestSessionFile,
  getSessionFileByID,
  listAllSessions,
  loadSessionMessages,
} from "./session.ts";
import { loadAllSkills } from "./skills.ts";

// ANSI terminal colors
export const colors = {
  bold:       (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:        (s: string) => `\x1b[2m${s}\x1b[0m`,
  italic:     (s: string) => `\x1b[3m${s}\x1b[0m`,
  cyan:       (s: string) => `\x1b[36m${s}\x1b[0m`,
  green:      (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:     (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray:       (s: string) => `\x1b[90m${s}\x1b[0m`,
  red:        (s: string) => `\x1b[31m${s}\x1b[0m`,
  boldCyan:   (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  boldGreen:  (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
};

// JSON-RPC types for server mode
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

// CLI single-prompt mode (-p "...")
async function runCliMode(
  prompt: string,
  options: { isContinue?: boolean; resumeId?: string },
) {
  let sessionFile: string;
  let history: any[] = [];

  // Resume or continue session
  if (options.resumeId) {
    const target = getSessionFileByID(options.resumeId);
    if (!target) {
      process.stderr.write(`Error: session not found: ${options.resumeId}\n`);
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

// Interactive terminal REPL mode
async function runReplMode(options: { isContinue?: boolean; resumeId?: string }) {
  let currentSessionFile: string;
  let history: any[] = [];

  // Session initialization
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

  // Welcome banner
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

    // Slash command handling
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
            `\n  ${colors.boldYellow("/skills")}           List available skills` +
            `\n  ${colors.boldYellow("/clear")} | ${colors.boldYellow("/new")}     Start a fresh session` +
            `\n  ${colors.boldYellow("/sessions")} | ${colors.boldYellow("/list")} List saved sessions` +
            `\n  ${colors.boldYellow("/resume <id>")}    Resume an existing session` +
            `\n  ${colors.boldYellow("/exit")} | ${colors.boldYellow("/quit")}     Exit\n`,
          );
          break;

        case "/skills": {
          const skills = loadAllSkills();
          if (skills.length === 0) {
            console.log(colors.gray("No skills found in .agents/skills/\n"));
          } else {
            console.log("\n" + colors.bold("Available Skills:"));
            console.log(colors.gray("─".repeat(68)));
            for (const s of skills) {
              const toolInfo = s.tools ? colors.dim(` [tools: ${s.tools.join(", ")}]`) : "";
              console.log(`• ${colors.boldCyan(s.name)}${toolInfo}\n  ${colors.gray(s.description)}`);
            }
            console.log();
          }
          break;
        }

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

    // Run prompt in agent
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

// JSON-RPC 2.0 ACP server mode
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
        const notifyTool = (toolName: string, summary: string) => {
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", method: "session/tool_call", params: { tool: toolName, summary } }) + "\n",
          );
        };
        try {
          const result = await runAgentMode(userPrompt, sessionMessages, currentSessionFile, "server", notifyTool);
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

// Main CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const isContinue = args.includes("--continue") || args.includes("-c");
  const resumeIdx = args.findIndex((a) => a === "--resume" || a === "-r");
  const resumeId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  // --skills
  if (args.includes("--skills")) {
    const skills = loadAllSkills();
    if (skills.length === 0) { console.log("No skills found in .agents/skills/"); return; }
    console.log("Available Skills:\n" + "─".repeat(68));
    for (const s of skills) {
      const toolInfo = s.tools ? ` [tools: ${s.tools.join(", ")}]` : "";
      console.log(`• ${s.name}${toolInfo}\n  ${s.description}`);
    }
    return;
  }

  // --list
  if (args.includes("--list") || args.includes("-l")) {
    const sessions = listAllSessions();
    if (sessions.length === 0) { console.log("No saved sessions found."); return; }
    console.log("Saved Sessions:\n" + "─".repeat(68));
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

  // -p "prompt"
  const pIdx = args.indexOf("-p");
  if (pIdx !== -1 && args[pIdx + 1]) {
    await runCliMode(args[pIdx + 1], { isContinue, resumeId });
    return;
  }

  // REPL vs Server
  const isServer = args.includes("--server") || args.includes("-s");
  const isTTY = process.stdin.isTTY && !isServer && !process.env.CI;

  if (isTTY || args.includes("--interactive") || args.includes("-i")) {
    await runReplMode({ isContinue, resumeId });
  } else {
    await runServerMode();
  }
}

main();
