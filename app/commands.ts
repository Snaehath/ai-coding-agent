import fs from "node:fs";
import path from "node:path";

// Constants
export const COMMANDS_DIR = path.resolve(process.cwd(), ".agents", "commands");

// Types
export type CustomCommand = {
  name: string;
  description: string;
  template: string;
  filePath: string;
};

// Parse command markdown file
export function parseCommandMarkdown(content: string, filePath: string): CustomCommand | null {
  let name = path.basename(filePath, ".md").toLowerCase();
  let description = "";
  let template = content.trim();

  // Parse YAML frontmatter if present
  const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (yamlMatch) {
    const rawYaml = yamlMatch[1];
    template = yamlMatch[2].trim();

    for (const rawLine of rawYaml.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("description:")) {
        description = line.replace(/^description:\s*/, "").replace(/^["']|["']$/g, "").trim();
      } else if (line.startsWith("name:")) {
        name = line.replace(/^name:\s*/, "").replace(/^["']|["']$/g, "").trim();
      }
    }
  }

  if (!description) {
    description = `Execute /${name} command template`;
  }

  return {
    name,
    description,
    template,
    filePath,
  };
}

// Load all custom commands from workspace .agents/commands/ and global install dir
export function loadAllCommands(dir: string = COMMANDS_DIR): Map<string, CustomCommand> {
  const globalDir = path.resolve(
    import.meta.dir,
    "..",
    ".agents",
    "commands",
  );

  const commands = new Map<string, CustomCommand>();

  function scanDir(targetDir: string) {
    if (!fs.existsSync(targetDir)) return;
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = path.join(targetDir, entry.name);
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const cmd = parseCommandMarkdown(content, fullPath);
          if (cmd && !commands.has(cmd.name)) {
            commands.set(cmd.name, cmd);
          }
        } catch (e: any) {
          process.stderr.write(`[Commands] Failed to load ${fullPath}: ${e.message}\n`);
        }
      }
    }
  }

  scanDir(dir);
  if (path.resolve(dir) !== path.resolve(globalDir)) {
    scanDir(globalDir);
  }

  return commands;
}

// Expand template variables ($ARGUMENTS, $1, $2, etc.)
export function expandCommandTemplate(template: string, rawArgs: string): string {
  let expanded = template;
  const trimmedArgs = rawArgs.trim();

  // Replace $ARGUMENTS with full argument string
  expanded = expanded.replace(/\$ARGUMENTS/g, trimmedArgs);

  // Replace positional $1, $2, $3...
  const parts = trimmedArgs.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const regex = new RegExp(`\\$${i + 1}`, "g");
    expanded = expanded.replace(regex, parts[i]);
  }

  // Clear unfulfilled positional parameters
  expanded = expanded.replace(/\$\d+/g, "");

  return expanded.trim();
}
