import path from "node:path";
import * as readline from "node:readline";
import { runAgentMode } from "./agent.ts";
import {
  createNewSessionPath,
  getSessionFileByID,
  getLatestSessionFile,
  listAllSessions,
  loadSessionMessages,
  rewriteSessionFile,
} from "./session.ts";
import { loadAllSkills } from "./skills.ts";
import { loadPermissionConfig } from "./permissions.ts";
import { loadHooksConfig } from "./hooks.ts";
import { loadAllCommands, expandCommandTemplate } from "./commands.ts";
import {
  aggregateSessionTelemetry,
  formatTelemetryBox,
} from "./telemetry.ts";
import {
  REGISTERED_MODELS,
  resolveModel,
  promptSelectModel,
} from "./models.ts";
import {
  createMarkdownStreamer,
  renderTerminalMarkdown,
} from "./markdown.ts";
import { renderModelBanner } from "./banners.ts";
import { renderEntropyReport } from "./entropy.ts";
import { middlewarePipeline } from "./middleware.ts";
import { stateMachine } from "./state-machine.ts";
import { evaluatorEngine } from "./evaluators.ts";

// ANSI terminal colors
export const colors = {
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

// Interactive terminal REPL mode
export async function runReplMode(options: {
  isContinue?: boolean;
  resumeId?: string;
}) {
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
  const sessionStartTime = Date.now();

  // Welcome banner
  console.log(
    "\n" +
      colors.boldCyan(
        "╔═══════════════════════════════════════════════════════════╗",
      ) +
      "\n" +
      colors.boldCyan("║") +
      "           🤖 " +
      colors.bold("Local Coding Agent") +
      "            " +
      colors.boldCyan("║") +
      "\n" +
      colors.boldCyan(
        "╚═══════════════════════════════════════════════════════════╝",
      ),
  );
  console.log(
    colors.dim("  Type ") +
      colors.boldYellow("/help") +
      colors.dim(" for commands · ") +
      colors.boldYellow('"""') +
      colors.dim(" for multi-line · ") +
      colors.boldYellow("/exit") +
      colors.dim(" to quit"),
  );
  console.log(
    colors.dim("  Session: ") +
      colors.green(sessionId()) +
      colors.dim(` (${history.length} msgs)`),
  );
  console.log(renderModelBanner(currentModel()));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
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
      console.log(
        colors.dim(
          '  (Multi-line mode active. Type \'"""\' to finish and submit)',
        ),
      );
      ask();
      continue;
    }

    if (isMultiLineMode) {
      if (trimmed === '"""' || trimmed === "'''" || trimmed === "/end") {
        isMultiLineMode = false;
        const fullPrompt = multiLineBuffer.join("\n").trim();
        multiLineBuffer = [];
        if (!fullPrompt) {
          ask();
          continue;
        }
      } else {
        multiLineBuffer.push(rawLine);
        ask();
        continue;
      }
    }

    const input = (
      isMultiLineMode
        ? ""
        : multiLineBuffer.length > 0
          ? multiLineBuffer.join("\n")
          : rawLine
    ).trim();
    if (!input) {
      ask();
      continue;
    }

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
            "\n" +
              colors.bold("System Commands:") +
              `\n  ${colors.boldYellow("/help")}             Show this menu` +
              `\n  ${colors.boldYellow("/compact")}          Compress conversation history to save tokens` +
              `\n  ${colors.boldYellow("/model [name]")}     Switch AI model (opens interactive selector)` +
              `\n  ${colors.boldYellow("/thinking [level]")} Set reasoning effort (low, high, off)` +
              `\n  ${colors.boldYellow("/image <path>")}     Attach an image for vision models` +
              `\n  ${colors.boldYellow("/history")}          View recent conversation history` +
              `\n  ${colors.boldYellow("/paste")}            Start multi-line paste mode` +
              `\n  ${colors.boldYellow("/skills")}           List available skills` +
              `\n  ${colors.boldYellow("/permissions")}      List active permission policies` +
              `\n  ${colors.boldYellow("/hooks")}            List active lifecycle hooks` +
              `\n  ${colors.boldYellow("/middleware")}       List active request/response interceptors` +
              `\n  ${colors.boldYellow("/state")}            View agent lifecycle state machine & history` +
              `\n  ${colors.boldYellow("/eval")} | ${colors.boldYellow("/judge")}   Evaluate & score latest response quality` +
              `\n  ${colors.boldYellow("/entropy")} | ${colors.boldYellow("/gc")}   Scan for dead code, unused deps & project entropy` +
              `\n  ${colors.boldYellow("/stats")}            View real-time agent telemetry & metrics` +
              `\n  ${colors.boldYellow("/clear")} | ${colors.boldYellow("/new")}     Start a fresh session` +
              `\n  ${colors.boldYellow("/sessions")} | ${colors.boldYellow("/list")} List saved sessions` +
              `\n  ${colors.boldYellow("/resume <id>")}    Resume an existing session` +
              `\n  ${colors.boldYellow("/exit")} | ${colors.boldYellow("/quit")}     Exit`,
          );

          const customList = Array.from(customCommands.values());
          if (customList.length > 0) {
            console.log("\n" + colors.bold("Custom Slash Commands:"));
            for (const c of customList) {
              console.log(
                `  ${colors.boldCyan("/" + c.name)}  ${colors.gray(c.description)}`,
              );
            }
          }
          console.log();
          break;
        }

        case "/compact": {
          if (history.length <= 2) {
            console.log(
              colors.gray("Session history is too short to compact.\n"),
            );
            break;
          }
          console.log(colors.dim("  Compressing session history with LLM..."));
          try {
            const summaryPrompt =
              "Summarize the key facts, decisions, and instructions from our conversation so far in 3-4 concise bullet points.";
            const summary = await runAgentMode(
              summaryPrompt,
              history,
              currentSessionFile,
              "cli",
            );
            history = [
              {
                role: "user",
                content: `[Context Summary of prior conversation]:\n${summary}`,
              },
              {
                role: "assistant",
                content:
                  "Understood. I have loaded the compressed session context and am ready to proceed.",
              },
            ];
            rewriteSessionFile(currentSessionFile, history);
            console.log(colors.green(`✨ Session compacted to 2 messages.\n`));
          } catch (e: any) {
            console.log(
              colors.red(`Failed to compact session: ${e.message}\n`),
            );
          }
          break;
        }

        case "/model": {
          const rawArg = rest[0];
          if (rawArg) {
            const targetModel = resolveModel(rawArg);
            process.env.MODEL = targetModel.id;
            console.log(renderModelBanner(targetModel.id));
          } else {
            rl.pause();
            const chosen = await promptSelectModel(currentModel());
            process.env.MODEL = chosen.id;
            rl.resume();
            console.log(renderModelBanner(chosen.id));
          }
          break;
        }

        case "/thinking": {
          const arg = rest[0]?.toLowerCase().trim();
          if (arg && ["low", "medium", "high", "off", "none"].includes(arg)) {
            process.env.THINKING_EFFORT = arg === "none" ? "off" : arg;
            console.log(
              colors.green(
                `✨ Thinking effort set to: ${colors.boldCyan(process.env.THINKING_EFFORT.toUpperCase())}\n`,
              ),
            );
          } else {
            const current = process.env.THINKING_EFFORT ?? "high (default)";
            console.log(
              `\n${colors.bold("Thinking / Reasoning Mode:")}\n` +
                `  Current: ${colors.boldCyan(current.toUpperCase())}\n\n` +
                `  ${colors.boldYellow("/thinking low")}     Faster, lightweight reasoning pass\n` +
                `  ${colors.boldYellow("/thinking high")}    Deep, exhaustive multi-step reasoning\n` +
                `  ${colors.boldYellow("/thinking off")}     Disable thinking block for direct answers\n`,
            );
          }
          break;
        }

        case "/image":
        case "/img": {
          const imgPath = rest[0];
          const userPrompt =
            rest.slice(1).join(" ").trim() ||
            "Describe and analyze this image in detail.";
          if (!imgPath) {
            console.log(
              colors.red("Usage: /image <path/to/image.png> [optional question]\n"),
            );
            break;
          }

          try {
            isRunning = true;
            let streamedAny = false;
            const mdStreamer = createMarkdownStreamer((text) => {
              if (!streamedAny) {
                process.stdout.write(colors.boldCyan("agent ❯ "));
                streamedAny = true;
              }
              process.stdout.write(text);
            });

            const result = await runAgentMode(
              userPrompt,
              history,
              currentSessionFile,
              "repl",
              undefined,
              (t) => mdStreamer.write(t),
              [imgPath],
            );

            mdStreamer.flush();

            if (!streamedAny) {
              process.stdout.write(
                colors.boldCyan("agent ❯ ") + renderTerminalMarkdown(result),
              );
            }
            process.stdout.write("\n\n");
          } catch (e: any) {
            process.stdout.write(`\n${colors.red(`Error: ${e.message}`)}\n\n`);
          } finally {
            isRunning = false;
          }
          break;
        }

        case "/history": {
          if (history.length === 0) {
            console.log(colors.gray("No messages in current session.\n"));
          } else {
            console.log(
              "\n" + colors.bold(`Session History (${sessionId()}):`),
            );
            console.log(colors.gray("─".repeat(68)));
            for (const m of history.slice(-6)) {
              if (m.role === "system") continue;
              const roleTag =
                m.role === "user"
                  ? colors.boldGreen("user:")
                  : colors.boldCyan("agent:");
              const text =
                typeof m.content === "string"
                  ? m.content.slice(0, 100)
                  : "[tool calls]";
              console.log(`${roleTag} ${text}`);
            }
            console.log();
          }
          break;
        }

        case "/paste":
          isMultiLineMode = true;
          multiLineBuffer = [];
          console.log(
            colors.dim(
              "  (Multi-line paste mode active. Type '\"\"\"' or '/end' to submit)",
            ),
          );
          break;

        case "/permissions": {
          const permConfig = loadPermissionConfig();
          console.log("\n" + colors.bold("Active Permission Policies:"));
          console.log(colors.gray("─".repeat(68)));
          console.log(
            `Default Action: ${colors.boldGreen(permConfig.defaultAction.toUpperCase())}\n`,
          );
          for (const r of permConfig.rules) {
            const actionColor =
              r.action === "deny"
                ? colors.red
                : r.action === "ask"
                  ? colors.yellow
                  : colors.green;
            const pat = r.pattern ? ` [pattern: ${r.pattern}]` : "";
            console.log(
              `• [${actionColor(r.action.toUpperCase())}] ${colors.bold(r.tool)}${pat}\n  ${colors.gray(r.description ?? "No description")}`,
            );
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
              const toolInfo = s.tools
                ? colors.dim(` [tools: ${s.tools.join(", ")}]`)
                : "";
              console.log(
                `• ${colors.boldCyan(s.name)}${toolInfo}\n  ${colors.gray(s.description)}`,
              );
            }
            console.log();
          }
          break;
        }

        case "/hooks": {
          const hooksConfig = loadHooksConfig();
          console.log("\n" + colors.bold("Active Lifecycle Hooks:"));
          console.log(colors.gray("─".repeat(68)));
          console.log(
            `Status: ${hooksConfig.enabled !== false ? colors.boldGreen("ENABLED") : colors.red("DISABLED")}\n`,
          );
          for (const h of hooksConfig.hooks) {
            const toolStr = h.tool ? ` [tool: ${h.tool}]` : "";
            const actionStr = h.action ? ` [action: ${h.action}]` : "";
            const cmdStr = h.command ? ` [cmd: ${h.command}]` : "";
            console.log(
              `• ${colors.boldMagenta(h.event)}${colors.cyan(toolStr)}${colors.yellow(actionStr)}${colors.gray(cmdStr)}\n  ${colors.dim(h.description ?? "No description")}`,
            );
          }
          console.log();
          break;
        }

        case "/middleware": {
          await middlewarePipeline.loadUserMiddlewares();
          const list = middlewarePipeline.list();
          console.log("\n" + colors.bold("Active Request/Response Middlewares:"));
          console.log(colors.gray("─".repeat(68)));
          for (const m of list) {
            const priorityStr = colors.yellow(`[priority: ${m.priority ?? 50}]`);
            const hooks = [
              m.beforeRequest ? "beforeRequest" : null,
              m.afterResponse ? "afterResponse" : null,
            ]
              .filter(Boolean)
              .join(", ");
            console.log(
              `• ${colors.boldCyan(m.name)} ${priorityStr} ${colors.dim(`(${hooks})`)}\n  ${colors.gray(m.description ?? "No description")}`,
            );
          }
          console.log();
          break;
        }

        case "/state":
        case "/lifecycle": {
          console.log("\n" + stateMachine.renderStateReport() + "\n");
          break;
        }

        case "/eval":
        case "/judge": {
          const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
          const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
          if (!lastAssistantMsg) {
            console.log(colors.yellow("\n⚠️ No assistant response available to evaluate yet.\n"));
            break;
          }
          const promptText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "User request";
          const outputText = typeof lastAssistantMsg.content === "string" ? lastAssistantMsg.content : "";
          const evalRes = await evaluatorEngine.evaluate({
            prompt: promptText,
            output: outputText,
            messages,
          });
          console.log("\n" + evaluatorEngine.formatEvaluationReport(evalRes) + "\n");
          break;
        }

        case "/stats":
        case "/telemetry": {
          const summary = aggregateSessionTelemetry(
            sessionId(),
            sessionStartTime,
          );
          console.log("\n" + formatTelemetryBox(summary) + "\n");
          break;
        }

        case "/entropy":
        case "/gc":
        case "/dead-code": {
          console.log(
            colors.dim("\n  🔍 Running Project Garbage Collector & Entropy Scan..."),
          );
          const report = renderEntropyReport();
          console.log("\n" + report + "\n");
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
                `${cur ? colors.boldGreen("▶ ") : "  "}${colors.cyan(s.id)}  ${colors.dim(s.messageCount + " msgs")}  ${colors.italic(s.title)}`,
              );
            }
            console.log();
          }
          break;
        }

        case "/resume": {
          const id = rest[0];
          if (!id) {
            console.log(colors.red("Usage: /resume <sessionId>\n"));
            break;
          }
          const target = getSessionFileByID(id);
          if (!target) {
            console.log(colors.red(`❌ Session not found: ${id}\n`));
          } else {
            currentSessionFile = target;
            history = loadSessionMessages(target);
            console.log(
              colors.green(`🔄 Resumed ${id} · ${history.length} messages\n`),
            );
          }
          break;
        }

        default: {
          const cmdName = cmd.slice(1).toLowerCase();
          if (customCommands.has(cmdName)) {
            const customCmd = customCommands.get(cmdName)!;
            const rawArgs = rest.join(" ");
            const expandedPrompt = expandCommandTemplate(
              customCmd.template,
              rawArgs,
            );
            console.log(
              colors.dim(
                `  ↳ [Custom Command /${cmdName}] ${customCmd.description}`,
              ),
            );

            try {
              isRunning = true;
              let streamedAny = false;
              const mdStreamer = createMarkdownStreamer((text) => {
                if (!streamedAny) {
                  process.stdout.write(colors.boldCyan("agent ❯ "));
                  streamedAny = true;
                }
                process.stdout.write(text);
              });

              const result = await runAgentMode(
                expandedPrompt,
                history,
                currentSessionFile,
                "repl",
                undefined,
                (t) => mdStreamer.write(t),
              );

              mdStreamer.flush();

              if (!streamedAny) {
                process.stdout.write(
                  colors.boldCyan("agent ❯ ") + renderTerminalMarkdown(result),
                );
              }
              process.stdout.write("\n\n");
            } catch (e: any) {
              process.stdout.write(
                `\n${colors.red(`Error: ${e.message}`)}\n\n`,
              );
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
      const mdStreamer = createMarkdownStreamer((text) => {
        if (!streamedAny) {
          process.stdout.write(colors.boldCyan("agent ❯ "));
          streamedAny = true;
        }
        process.stdout.write(text);
      });

      const result = await runAgentMode(
        input,
        history,
        currentSessionFile,
        "repl",
        undefined,
        (t) => mdStreamer.write(t),
      );

      mdStreamer.flush();

      if (!streamedAny) {
        process.stdout.write(
          colors.boldCyan("agent ❯ ") + renderTerminalMarkdown(result),
        );
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
