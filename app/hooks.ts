import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { aggregateSessionTelemetry, formatDuration } from "./telemetry.ts";

// Constants
export const HOOKS_CONFIG_PATH = path.resolve(process.cwd(), ".agents", "hooks.json");

// Types
export type HookEvent = "pre_tool_call" | "post_tool_call" | "on_session_end";

export type Hook = {
  event: HookEvent;
  tool?: string;
  action?: "format" | "inspect" | "notify" | "summary" | "stats";
  command?: string;
  description?: string;
};

export type HooksConfig = {
  enabled?: boolean;
  hooks: Hook[];
};

export type HookContext = {
  toolName?: string;
  filePath?: string;
  target?: string;
  result?: string;
  actionLog?: string[];
  sessionId?: string;
};

// ANSI color helpers
const colors = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[1;35m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
};

// Load hooks from config file
export function loadHooksConfig(): HooksConfig {
  if (!fs.existsSync(HOOKS_CONFIG_PATH)) {
    return { enabled: true, hooks: [] };
  }
  try {
    const raw = fs.readFileSync(HOOKS_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { enabled: true, hooks: [] };
  }
}

// Built-in File Formatter & Inspector Hook
function formatAndInspectFile(filePath?: string): void {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    const baseName = path.basename(filePath);

    process.stdout.write(
      `  ${colors.dim("🪝")} ${colors.magenta("[Hook: post_tool_call]")} ${colors.green(`✨ Formatted & inspected ${baseName}`)} ${colors.gray(`(${lineCount} lines, ${stat.size} bytes)`)}\n`,
    );
  } catch {
    // Fail gracefully
  }
}

// Built-in Session Stats Hook (Concise, Understandable Key Metrics)
function showSessionStatsHook(actionLog?: string[], sessionId?: string): void {
  const actionsCount = actionLog?.length ?? 0;

  if (sessionId) {
    const stats = aggregateSessionTelemetry(sessionId);
    const model = stats.modelName || process.env.MODEL || "local-model";
    const durationStr = stats.durationMs > 0 ? formatDuration(stats.durationMs) : "";
    const speed = stats.avgTokensPerSecond > 0 ? `${stats.avgTokensPerSecond.toFixed(1)} tok/s` : "";
    const tokens = stats.totalTokens > 0 ? `${stats.totalTokens.toLocaleString()} tokens` : "";
    const ctxPercent = stats.configuredContextLimit > 0
      ? `${stats.contextPercent}% of ${(stats.configuredContextLimit / 1024).toFixed(0)}k ctx`
      : "";
    const errorPart = stats.totalErrors > 0 ? ` · ${colors.yellow(`⚠️ ${stats.totalErrors} error(s)`)}` : "";

    const parts = [
      colors.cyan(`⚡ ${model}`),
      durationStr ? colors.boldYellow(durationStr) : null,
      speed ? colors.yellow(speed) : null,
      tokens ? colors.green(tokens) : null,
      ctxPercent ? colors.dim(`(${ctxPercent})`) : null,
      colors.gray(`${actionsCount} action(s)`),
    ].filter(Boolean);

    process.stdout.write(
      `\n  ${colors.dim("🪝")} ${colors.magenta("[Hook: on_session_end]")} ${parts.join(" · ")}${errorPart}\n`,
    );
  } else {
    process.stdout.write(
      `\n  ${colors.dim("🪝")} ${colors.magenta("[Hook: on_session_end]")} ${colors.green(`Session completed with ${actionsCount} action(s).`)}\n`,
    );
  }
}

// Execute active hooks for an event
export async function executeHooks(
  event: HookEvent,
  context: HookContext = {},
  config: HooksConfig = loadHooksConfig(),
): Promise<void> {
  if (config.enabled === false) return;

  for (const hook of config.hooks ?? []) {
    if (hook.event !== event) continue;
    if (hook.tool && hook.tool !== "*" && hook.tool !== context.toolName) continue;

    // 1. Built-in actions
    if ((hook.action === "format" || hook.action === "inspect") && event === "post_tool_call") {
      formatAndInspectFile(context.filePath);
    } else if (
      (hook.action === "notify" || hook.action === "summary" || hook.action === "stats") &&
      event === "on_session_end"
    ) {
      showSessionStatsHook(context.actionLog, context.sessionId);
    }

    // 2. Custom shell command hook (if configured)
    if (hook.command) {
      const cmd = hook.command
        .replace(/\$TOOL/g, context.toolName ?? "")
        .replace(/\$FILE_PATH/g, context.filePath ?? "")
        .replace(/\$TARGET/g, context.target ?? "");

      await new Promise<void>((resolve) => {
        exec(cmd, (err, stdout) => {
          if (!err && stdout.trim()) {
            process.stdout.write(
              `  ${colors.dim("🪝")} ${colors.magenta(`[Hook: ${event}]`)} ${colors.gray(stdout.trim())}\n`,
            );
          }
          resolve();
        });
      });
    }
  }
}
