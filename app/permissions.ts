import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

// Constants
export const PERMISSIONS_CONFIG_PATH = path.resolve(process.cwd(), ".agents", "permissions.json");

// Types
export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionRule = {
  tool: string; // "Read", "Write", "Bash", "WebSearch", "*"
  pattern?: string; // Optional path or command glob pattern
  action: PermissionAction;
  description?: string;
};

export type PermissionConfig = {
  defaultAction: PermissionAction;
  rules: PermissionRule[];
};

// Default fallback permissions
export const DEFAULT_PERMISSIONS: PermissionConfig = {
  defaultAction: "allow",
  rules: [
    // Deny sensitive files
    { tool: "Read", pattern: "**/.env*", action: "deny", description: "Protect environment secrets" },
    { tool: "Write", pattern: "**/.env*", action: "deny", description: "Protect environment secrets" },
    { tool: "Read", pattern: "**/.git/**", action: "deny", description: "Protect git internals" },

    // Ask on destructive bash commands
    { tool: "Bash", pattern: "*rm *", action: "ask", description: "Confirm file deletion" },
    { tool: "Bash", pattern: "*git reset*", action: "ask", description: "Confirm git reset" },
    { tool: "Bash", pattern: "*drop *", action: "ask", description: "Confirm database drop" },
    { tool: "Bash", pattern: "*kill *", action: "ask", description: "Confirm process kill" },

    // Ask on writing to critical directories
    { tool: "Write", pattern: "**/package.json", action: "ask", description: "Confirm package changes" },

    // Allow safe tools by default
    { tool: "Read", action: "allow" },
    { tool: "WebSearch", action: "allow" },
    { tool: "Bash", action: "allow" },
    { tool: "Write", action: "allow" },
  ],
};

// Simple glob to RegExp converter with safe token replacement
function globToRegex(glob: string): RegExp {
  let p = glob.replace(/\\/g, "/");
  p = p.replace(/\*\*\//g, "___GLOBSTAR_SLASH___");
  p = p.replace(/\*\*/g, "___GLOBSTAR___");
  p = p.replace(/\*/g, "___STAR___");
  p = p.replace(/\?/g, "___QUESTION___");

  p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  p = p.replace(/___GLOBSTAR_SLASH___/g, "(?:.*/)?");
  p = p.replace(/___GLOBSTAR___/g, ".*");
  p = p.replace(/___STAR___/g, "[^/]*");
  p = p.replace(/___QUESTION___/g, ".");

  return new RegExp(`^${p}$`, "i");
}

// Check if target matches glob pattern or substring
export function matchesPattern(target: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true;

  const normalizedTarget = target.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const baseName = path.basename(normalizedTarget);

  // Substring match for commands (e.g. "*rm *" matching "rm test.txt")
  if (normalizedPattern.startsWith("*") && normalizedPattern.endsWith("*")) {
    const sub = normalizedPattern.slice(1, -1);
    if (sub && normalizedTarget.toLowerCase().includes(sub.toLowerCase())) return true;
  }

  // Regex/glob match against full path, relative path, and basename
  try {
    const regex = globToRegex(normalizedPattern);
    if (regex.test(normalizedTarget) || regex.test(baseName)) return true;
  } catch { /* fallback */ }

  // Direct check for sensitive files (e.g. .env, .env.local, .git)
  if (normalizedPattern.includes(".env") && (baseName.toLowerCase().startsWith(".env") || normalizedTarget.toLowerCase().includes(".env"))) {
    return true;
  }
  if (normalizedPattern.includes(".git") && (normalizedTarget.includes("/.git/") || normalizedTarget.endsWith("/.git") || baseName === ".git")) {
    return true;
  }

  return false;
}

// Load permissions configuration from file
export function loadPermissionConfig(): PermissionConfig {
  if (!fs.existsSync(PERMISSIONS_CONFIG_PATH)) {
    return DEFAULT_PERMISSIONS;
  }

  try {
    const raw = fs.readFileSync(PERMISSIONS_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      defaultAction: parsed.defaultAction ?? "allow",
      rules: parsed.rules ?? DEFAULT_PERMISSIONS.rules,
    };
  } catch (e: any) {
    process.stderr.write(`[Permissions] Failed to parse permissions.json: ${e.message}\n`);
    return DEFAULT_PERMISSIONS;
  }
}

// Evaluate permission for a tool call
export function evaluatePermission(
  toolName: string,
  target: string,
  config: PermissionConfig,
  runtimeCache: Map<string, PermissionAction>,
): { action: PermissionAction; rule?: PermissionRule } {
  const cacheKey = `${toolName}:${target}`;

  // Check runtime session cache (e.g. user selected "always allow" or "never allow")
  if (runtimeCache.has(cacheKey)) {
    return { action: runtimeCache.get(cacheKey)! };
  }

  // Check tool-level cache
  if (runtimeCache.has(`${toolName}:*`)) {
    return { action: runtimeCache.get(`${toolName}:*`)! };
  }

  // Evaluate rules in priority order
  for (const rule of config.rules) {
    if (rule.tool !== "*" && rule.tool !== toolName) continue;

    if (rule.pattern) {
      if (matchesPattern(target, rule.pattern)) {
        return { action: rule.action, rule };
      }
    } else {
      // General tool rule without pattern
      return { action: rule.action, rule };
    }
  }

  return { action: config.defaultAction };
}

// Interactive confirmation prompt in terminal
export async function promptUserPermission(
  toolName: string,
  summary: string,
  target: string,
  runtimeCache: Map<string, PermissionAction>,
): Promise<boolean> {
  // Non-interactive / CI check
  if (!process.stdin.isTTY) {
    process.stderr.write(`[Permissions] Denying tool call in non-interactive mode: ${toolName}\n`);
    return false;
  }

  const boldYellow = (s: string) => `\x1b[1;33m${s}\x1b[0m`;
  const boldCyan = (s: string) => `\x1b[1;36m${s}\x1b[0m`;
  const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

  process.stdout.write(
    `\n  ${boldYellow("⚠️  Permission Required")}\n` +
    `  Tool:   ${boldCyan(toolName)}\n` +
    `  Action: ${gray(summary)}\n` +
    `  ${bold("Allow execution?")} [${bold("y")}es / ${bold("n")}o / ${bold("a")}lways / ne${bold("v")}er]: `,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      const choice = answer.trim().toLowerCase();

      if (choice === "y" || choice === "yes") {
        resolve(true);
      } else if (choice === "a" || choice === "always") {
        // Cache permission for this session
        runtimeCache.set(`${toolName}:${target}`, "allow");
        resolve(true);
      } else if (choice === "v" || choice === "never") {
        // Cache denial for this session
        runtimeCache.set(`${toolName}:${target}`, "deny");
        resolve(false);
      } else {
        // Default to deny on no or unrecognized answer
        resolve(false);
      }
    });
  });
}
