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
  rewriteSessionFile,
} from "./session.ts";
import { loadAllSkills } from "./skills.ts";
import { loadPermissionConfig } from "./permissions.ts";
import { loadAllCommands, expandCommandTemplate } from "./commands.ts";

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

  let actualPrompt = prompt.trim();
  // Normalize Git Bash MSYS2 path translation (e.g. C:/Program Files/Git/explain -> /explain)
  actualPrompt = actualPrompt.replace(/^[A-Za-z]:[/\\]Program Files[/\\]Git[/\\]/i, "/");

  if (actualPrompt.startsWith("/")) {
    const [cmd, ...rest] = actualPrompt.split(/\s+/);
    const cmdName = cmd.slice(1).toLowerCase();
    const customCommands = loadAllCommands();
    if (customCommands.has(cmdName)) {
      const customCmd = customCommands.get(cmdName)!;
      actualPrompt = expandCommandTemplate(customCmd.template, rest.join(" "));
      process.stdout.write(colors.dim(`↳ [Custom Command /${cmdName}] ${customCmd.description}\n`));
    }
  }

  const result = await runAgentMode(actualPrompt, history, sessionFile, "cli");
  process.stdout.write(result + "\n");
}

// Interactive terminal REPL mode
async function runReplMode(options: { isContinue?: boolean; resumeId?: string }) {
  let currentSessionFile: string;
  let history: any[] = [];
  const customCommands = loadAllCommands();

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
  const currentModel = () => process.env.MODEL ?? "anthropic/claude-haiku-4.5";

  // Welcome banner
  console.log(
    "\n" + colors.boldCyan("╔═══════════════════════════════════════════════════════════╗") +
    "\n" + colors.boldCyan("║") + "           🤖 " + colors.bold("AI Coding Agent  (Interactive TUI)") + "            " + colors.boldCyan("║") +
    "\n" + colors.boldCyan("╚═══════════════════════════════════════════════════════════╝"),
  );
  console.log(colors.dim("  Type ") + colors.boldYellow("/help") + colors.dim(" for commands · ") + colors.boldYellow('"""') + colors.dim(" for multi-line · ") + colors.boldYellow("/exit") + colors.dim(" to quit"));
  console.log(colors.dim("  Model: ") + colors.cyan(currentModel()) + colors.dim(" · Session: ") + colors.green(sessionId()) + colors.dim(` (${history.length} msgs)\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let isRunning = false;
  let multiLineBuffer: string[] = [];
  let isMultiLineMode = false;

  const ask = () => {
    if (isMultiLineMode) {
      process.stdout.write(colors.boldYellow("... ❯ "));
    } else {
      process.stdout.write(colors.boldGreen("you ❯ "));
    }
  };

  // Graceful SIGINT handling
  process.on("SIGINT", () => {
    if (isRunning) {
      process.stdout.write(colors.yellow("\n⚠️ Generation interrupted.\n"));
      isRunning = false;
      ask();
    } else {
      process.stdout.write(colors.dim("\nGoodbye! 👋\n"));
      process.exit(0);
    }
  });

  ask();

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();

    // Multi-line mode handling
    if (!isMultiLineMode && (trimmed === '"""' || trimmed === "'''")) {
      isMultiLineMode = true;
      multiLineBuffer = [];
      console.log(colors.dim("  (Multi-line mode active. Type '\"\"\"' to finish and submit)"));
      ask();
      continue;
    }

    if (isMultiLineMode) {
      if (trimmed === '"""' || trimmed === "'''" || trimmed === "/end") {
        isMultiLineMode = false;
        const fullPrompt = multiLineBuffer.join("\n").trim();
        multiLineBuffer = [];
        if (!fullPrompt) { ask(); continue; }
        // Process accumulated multi-line prompt below
      } else {
        multiLineBuffer.push(rawLine);
        ask();
        continue;
      }
    }

    const input = (isMultiLineMode ? "" : multiLineBuffer.length > 0 ? multiLineBuffer.join("\n") : rawLine).trim();
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

        case "/help": {
          console.log(
            "\n" + colors.bold("System Commands:") +
            `\n  ${colors.boldYellow("/help")}             Show this menu` +
            `\n  ${colors.boldYellow("/compact")}          Compress conversation history to save tokens` +
            `\n  ${colors.boldYellow("/model [name]")}     View or switch active LLM model` +
            `\n  ${colors.boldYellow("/history")}          View recent conversation history` +
            `\n  ${colors.boldYellow("/paste")}            Start multi-line paste mode` +
            `\n  ${colors.boldYellow("/skills")}           List available skills` +
            `\n  ${colors.boldYellow("/permissions")}      List active permission policies` +
            `\n  ${colors.boldYellow("/clear")} | ${colors.boldYellow("/new")}     Start a fresh session` +
            `\n  ${colors.boldYellow("/sessions")} | ${colors.boldYellow("/list")} List saved sessions` +
            `\n  ${colors.boldYellow("/resume <id>")}    Resume an existing session` +
            `\n  ${colors.boldYellow("/exit")} | ${colors.boldYellow("/quit")}     Exit`,
          );

          const customList = Array.from(customCommands.values());
          if (customList.length > 0) {
            console.log("\n" + colors.bold("Custom Slash Commands:"));
            for (const c of customList) {
              console.log(`  ${colors.boldCyan("/" + c.name)}  ${colors.gray(c.description)}`);
            }
          }
          console.log();
          break;
        }

        case "/compact": {
          if (history.length <= 2) {
            console.log(colors.gray("Session history is too short to compact.\n"));
            break;
          }
          console.log(colors.dim("  Compressing session history with LLM..."));
          try {
            const summaryPrompt = "Summarize the key facts, decisions, and instructions from our conversation so far in 3-4 concise bullet points.";
            const summary = await runAgentMode(summaryPrompt, history, currentSessionFile, "cli");
            history = [
              { role: "user", content: `[Context Summary of prior conversation]:\n${summary}` },
              { role: "assistant", content: "Understood. I have loaded the compressed session context and am ready to proceed." },
            ];
            rewriteSessionFile(currentSessionFile, history);
            console.log(colors.green(`✨ Session compacted to 2 messages.\n`));
          } catch (e: any) {
            console.log(colors.red(`Failed to compact session: ${e.message}\n`));
          }
          break;
        }

        case "/model": {
          const newModel = rest[0];
          if (newModel) {
            process.env.MODEL = newModel;
            console.log(colors.green(`✨ Active model changed to: ${newModel}\n`));
          } else {
            console.log(`\nActive Model: ${colors.boldCyan(currentModel())}\nUsage: ${colors.yellow("/model <model-name>")}\n`);
          }
          break;
        }

        case "/history": {
          if (history.length === 0) {
            console.log(colors.gray("No messages in current session.\n"));
          } else {
            console.log("\n" + colors.bold(`Session History (${sessionId()}):`));
            console.log(colors.gray("─".repeat(68)));
            for (const m of history.slice(-6)) {
              if (m.role === "system") continue;
              const roleTag = m.role === "user" ? colors.boldGreen("user:") : colors.boldCyan("agent:");
              const text = typeof m.content === "string" ? m.content.slice(0, 100) : "[tool calls]";
              console.log(`${roleTag} ${text}`);
            }
            console.log();
          }
          break;
        }

        case "/paste":
          isMultiLineMode = true;
          multiLineBuffer = [];
          console.log(colors.dim("  (Multi-line paste mode active. Type '\"\"\"' or '/end' to submit)"));
          break;

        case "/permissions": {
          const permConfig = loadPermissionConfig();
          console.log("\n" + colors.bold("Active Permission Policies:"));
          console.log(colors.gray("─".repeat(68)));
          console.log(`Default Action: ${colors.boldGreen(permConfig.defaultAction.toUpperCase())}\n`);
          for (const r of permConfig.rules) {
            const actionColor = r.action === "deny" ? colors.red : r.action === "ask" ? colors.yellow : colors.green;
            const pat = r.pattern ? ` [pattern: ${r.pattern}]` : "";
            console.log(`• [${actionColor(r.action.toUpperCase())}] ${colors.bold(r.tool)}${pat}\n  ${colors.gray(r.description ?? "No description")}`);
          }
          console.log();
          break;
        }

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

        default: {
          const cmdName = cmd.slice(1).toLowerCase();
          if (customCommands.has(cmdName)) {
            const customCmd = customCommands.get(cmdName)!;
            const rawArgs = rest.join(" ");
            const expandedPrompt = expandCommandTemplate(customCmd.template, rawArgs);
            console.log(colors.dim(`  ↳ [Custom Command /${cmdName}] ${customCmd.description}`));

            try {
              isRunning = true;
              let streamedAny = false;
              const onToken = (token: string) => {
                if (!streamedAny) {
                  process.stdout.write(colors.boldCyan("agent ❯ "));
                  streamedAny = true;
                }
                process.stdout.write(token);
              };

              const result = await runAgentMode(expandedPrompt, history, currentSessionFile, "repl", undefined, onToken);
              if (!streamedAny) {
                process.stdout.write(colors.boldCyan("agent ❯ ") + result);
              }
              process.stdout.write("\n\n");
            } catch (e: any) {
              process.stdout.write(`\n${colors.red(`Error: ${e.message}`)}\n\n`);
            } finally {
              isRunning = false;
            }
          } else {
            console.log(colors.red(`Unknown command: ${cmd}  (type /help)\n`));
          }
          break;
        }
      }
      ask();
      continue;
    }

    // Run prompt in agent with live streaming
    try {
      isRunning = true;
      let streamedAny = false;
      const onToken = (token: string) => {
        if (!streamedAny) {
          process.stdout.write(colors.boldCyan("agent ❯ "));
          streamedAny = true;
        }
        process.stdout.write(token);
      };

      const result = await runAgentMode(input, history, currentSessionFile, "repl", undefined, onToken);

      // If tokens weren't streamed directly (e.g. tool actions only), print the final result
      if (!streamedAny) {
        process.stdout.write(colors.boldCyan("agent ❯ ") + result);
      }
      process.stdout.write("\n\n");
    } catch (e: any) {
      process.stdout.write(`\n${colors.red(`Error: ${e.message}`)}\n\n`);
    } finally {
      isRunning = false;
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
            capabilities: { tools: ["Read", "Write", "Bash", "WebSearch"] },
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

  // --permissions
  if (args.includes("--permissions")) {
    const permConfig = loadPermissionConfig();
    console.log("Active Permission Policies:\n" + "─".repeat(68));
    console.log(`Default Action: ${permConfig.defaultAction.toUpperCase()}\n`);
    for (const r of permConfig.rules) {
      const pat = r.pattern ? ` [pattern: ${r.pattern}]` : "";
      console.log(`• [${r.action.toUpperCase()}] ${r.tool}${pat}\n  ${r.description ?? "No description"}`);
    }
    return;
  }

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
