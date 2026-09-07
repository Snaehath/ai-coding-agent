import path from "node:path";
import { runAgentMode } from "./agent.ts";
import {
  createNewSessionPath,
  deleteSessionById,
  getLatestSessionFile,
  getSessionFileByID,
  listAllSessions,
  loadSessionMessages,
} from "./session.ts";
import { loadAllSkills } from "./skills.ts";
import { loadPermissionConfig } from "./permissions.ts";
import { loadAllCommands, expandCommandTemplate } from "./commands.ts";
import {
  aggregateSessionTelemetry,
  formatTelemetryBox,
} from "./telemetry.ts";
import {
  REGISTERED_MODELS,
  determineActiveModel,
} from "./models.ts";
import { runReplMode, colors } from "./repl.ts";
import { runServerMode } from "./server.ts";
import {
  createMarkdownStreamer,
  renderTerminalMarkdown,
} from "./markdown.ts";

// CLI single-prompt mode (-p "...")
async function runCliMode(
  prompt: string,
  options: { isContinue?: boolean; resumeId?: string },
  imagePaths?: string[],
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
  actualPrompt = actualPrompt.replace(
    /^[A-Za-z]:[/\\]Program Files[/\\]Git[/\\]/i,
    "/",
  );

  if (actualPrompt.startsWith("/")) {
    const [cmd, ...rest] = actualPrompt.split(/\s+/);
    const cmdName = cmd.slice(1).toLowerCase();
    const customCommands = loadAllCommands();
    if (customCommands.has(cmdName)) {
      const customCmd = customCommands.get(cmdName)!;
      actualPrompt = expandCommandTemplate(customCmd.template, rest.join(" "));
      process.stdout.write(
        colors.dim(`↳ [Custom Command /${cmdName}] ${customCmd.description}\n`),
      );
    }
  }

  let streamedAny = false;
  const mdStreamer = createMarkdownStreamer((text) => {
    streamedAny = true;
    process.stdout.write(text);
  });

  const result = await runAgentMode(
    actualPrompt,
    history,
    sessionFile,
    "cli",
    undefined,
    (token) => mdStreamer.write(token),
    imagePaths,
  );

  mdStreamer.flush();

  if (!streamedAny) {
    process.stdout.write(renderTerminalMarkdown(result) + "\n");
  } else {
    process.stdout.write("\n");
  }
}

// Main CLI entry point & argument router
async function main() {
  const args = process.argv.slice(2);
  const isContinue = args.includes("--continue") || args.includes("-c");
  const resumeIdx = args.findIndex((a) => a === "--resume" || a === "-r");
  const resumeId = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;

  // Collect attached images (--image <path> or -i <path>)
  const imagePaths: string[] = [];
  for (let idx = 0; idx < args.length; idx++) {
    if (args[idx] === "--image" || (args[idx] === "-i" && args[idx + 1] && !args[idx + 1].startsWith("-"))) {
      if (args[idx + 1]) {
        imagePaths.push(args[idx + 1]);
      }
    }
  }

  // Resolve active model following precedence: CLI flag > .agents/models.json > .env > default
  const modelFlagIdx = args.findIndex((a) => a === "--model" || a === "-m");
  const cliModelArg = modelFlagIdx !== -1 ? args[modelFlagIdx + 1] : undefined;
  const activeModelId = determineActiveModel(cliModelArg);
  process.env.MODEL = activeModelId;

  // --thinking / -t / --think / -think flag (low, medium, high, off)
  const thinkingFlagIdx = args.findIndex(
    (a) =>
      a === "--thinking" ||
      a === "-t" ||
      a === "--think" ||
      a === "-think",
  );
  if (thinkingFlagIdx !== -1 && args[thinkingFlagIdx + 1]) {
    process.env.THINKING_EFFORT = args[thinkingFlagIdx + 1].toLowerCase();
  }

  // --persona / -persona / -P <name>
  const personaFlagIdx = args.findIndex(
    (a) => a === "--persona" || a === "-persona" || a === "-P",
  );
  if (personaFlagIdx !== -1 && args[personaFlagIdx + 1]) {
    const { resolvePersona } = await import("./personas.ts");
    const matched = resolvePersona(args[personaFlagIdx + 1]);
    if (matched) {
      process.env.PERSONA = matched.id;
    } else {
      process.stderr.write(
        colors.yellow(`⚠️ Warning: Persona "${args[personaFlagIdx + 1]}" not found. Running with default persona.\n`),
      );
    }
  }

  // --db <url_or_path> flag (Postgres, MySQL, SQLite)
  const dbFlagIdx = args.findIndex((a) => a === "--db");
  if (dbFlagIdx !== -1 && args[dbFlagIdx + 1]) {
    const dbTarget = args[dbFlagIdx + 1];
    const { dbManager } = await import("./connectors/db-manager.ts");
    const res = await dbManager.connect(dbTarget);
    if (res.ok) {
      process.stdout.write(
        colors.dim(`  ↳ [DB Connector] `) +
          colors.green(`${res.engine.toUpperCase()}`) +
          colors.dim(` connected (${res.tableCount} tables discovered in ${res.latencyMs}ms)\n`),
      );
    } else {
      process.stderr.write(
        colors.red(`  ↳ [DB Connector] Failed to connect: ${res.error}\n`),
      );
    }
  }

  // Direct CLI db command (e.g. `bun app/main.ts db connect <url>`, `bun app/main.ts db status`, `bun app/main.ts db tables`)
  if (args[0] === "db" || args[0] === "/db") {
    const sub = (args[1] || "").toLowerCase().trim();
    const target = args.slice(2).join(" ").trim();
    const { dbManager } = await import("./connectors/db-manager.ts");
    await dbManager.handleCliCommand(sub, target);
    return;
  }

  // --models / --list-models
  if (args.includes("--models") || args.includes("--list-models")) {
    const currentId = process.env.MODEL ?? activeModelId;
    console.log("Available AI Models:\n" + "─".repeat(68));
    for (const m of REGISTERED_MODELS) {
      const isActive =
        m.id.toLowerCase() === currentId.toLowerCase() ||
        Boolean(m.aliases?.some((a) => a.toLowerCase() === currentId.toLowerCase()));
      const badge = isActive ? " [ACTIVE]" : "";
      console.log(`• ${m.name}${badge}`);
      console.log(`  ID: ${m.id} | Aliases: ${(m.aliases ?? []).join(", ")}`);
      console.log(
        `  Creator: ${m.creator} | License: ${m.license} | ${m.vramUsage}`,
      );
      console.log(`  Good at: ${m.description}`);
      console.log(`  Capabilities: ${m.capabilities.join(" · ")}\n`);
    }
    console.log("Switch model with: -m granite, -m qwen, -m gemma, -m ministral, or -m lfm");
    return;
  }

  // --permissions
  if (args.includes("--permissions")) {
    const permConfig = loadPermissionConfig();
    console.log("Active Permission Policies:\n" + "─".repeat(68));
    console.log(`Default Action: ${permConfig.defaultAction.toUpperCase()}\n`);
    for (const r of permConfig.rules) {
      const pat = r.pattern ? ` [pattern: ${r.pattern}]` : "";
      console.log(
        `• [${r.action.toUpperCase()}] ${r.tool}${pat}\n  ${r.description ?? "No description"}`,
      );
    }
    return;
  }

  // --skills
  if (args.includes("--skills")) {
    const skills = loadAllSkills();
    if (skills.length === 0) {
      console.log("No skills found in .agents/skills/");
      return;
    }
    console.log("Available Skills:\n" + "─".repeat(68));
    for (const s of skills) {
      const toolInfo = s.tools ? ` [tools: ${s.tools.join(", ")}]` : "";
      console.log(`• ${s.name}${toolInfo}\n  ${s.description}`);
    }
    return;
  }

  // --personas / --list-personas
  if (args.includes("--personas") || args.includes("--list-personas")) {
    const { loadAllPersonas } = await import("./personas.ts");
    const personas = loadAllPersonas();
    console.log("Available Personas:\n" + "─".repeat(68));
    for (const p of personas) {
      const activeBadge = process.env.PERSONA === p.id ? " [ACTIVE]" : "";
      console.log(`• ${p.name} (${p.id})${activeBadge}`);
      console.log(`  ${p.description}`);
      if (p.allowedTools && p.allowedTools.length > 0) {
        console.log(`  Focused Tools: ${p.allowedTools.join(", ")}`);
      }
      console.log();
    }
    console.log("Activate with: -P <name> or -persona <name> (e.g. -P dba)");
    return;
  }

  // --stats / --telemetry
  if (args.includes("--stats") || args.includes("--telemetry")) {
    const latest = getLatestSessionFile();
    const sId = latest ? path.basename(latest, ".jsonl") : "default";
    const summary = aggregateSessionTelemetry(sId, Date.now() - 60000);
    console.log("\n" + formatTelemetryBox(summary) + "\n");
    return;
  }

  // --list
  if (args.includes("--list") || args.includes("-l")) {
    const sessions = listAllSessions();
    if (sessions.length === 0) {
      console.log("No saved sessions found.");
      return;
    }
    console.log("Saved Sessions:\n" + "─".repeat(68));
    for (const s of sessions) {
      console.log(
        `• ID: ${s.id} | ${s.messageCount} msgs | ${s.updatedAt}\n  Title: ${s.title}`,
      );
    }
    return;
  }

  // --delete <id>
  const delIdx = args.findIndex((a) => a === "--delete");
  if (delIdx !== -1 && args[delIdx + 1]) {
    const id = args[delIdx + 1];
    console.log(
      deleteSessionById(id)
        ? `✅ Deleted session '${id}'.`
        : `❌ Session '${id}' not found.`,
    );
    return;
  }

  // -instruct / --instruct / -instruction / --instruction / -f / --file <path>
  const instructIdx = args.findIndex(
    (a) =>
      a === "-instruct" ||
      a === "--instruct" ||
      a === "-instruction" ||
      a === "--instruction" ||
      a === "-f" ||
      a === "--file",
  );
  let instructContent = "";
  if (instructIdx !== -1 && args[instructIdx + 1]) {
    const filePath = path.resolve(process.cwd(), args[instructIdx + 1]);
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        process.stderr.write(`❌ Error: Instruction file not found: ${filePath}\n`);
        process.exit(1);
      }
      instructContent = (await file.text()).trim();
    } catch (err: any) {
      process.stderr.write(`❌ Error reading instruction file: ${err.message}\n`);
      process.exit(1);
    }
  }

  // -p "prompt"
  const pIdx = args.indexOf("-p");
  const pPrompt = pIdx !== -1 && args[pIdx + 1] ? args[pIdx + 1].trim() : "";

  // Run in CLI mode if either an instruction file or prompt is provided
  if (instructContent || pPrompt) {
    const combinedPrompt = instructContent
      ? pPrompt
        ? `${instructContent}\n\nAdditional Note: ${pPrompt}`
        : instructContent
      : pPrompt;
    await runCliMode(combinedPrompt, { isContinue, resumeId }, imagePaths);
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
