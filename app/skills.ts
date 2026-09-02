import fs from "node:fs";
import path from "node:path";

// Constants
export const SKILLS_DIR = path.resolve(process.cwd(), ".agents", "skills");

// Types
export type Skill = {
  name: string;
  description: string;
  tools?: string[];
  instructions: string;
  filePath: string;
};

// Parse YAML frontmatter and markdown body
export function parseSkillMarkdown(content: string, filePath: string): Skill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const rawYaml = match[1];
  const instructions = match[2].trim();

  let name = path.basename(path.dirname(filePath));
  let description = "";
  let tools: string[] | undefined = undefined;

  // Simple YAML line parser
  const lines = rawYaml.split("\n");
  let inToolsList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("name:")) {
      name = line.replace(/^name:\s*/, "").replace(/^["']|["']$/g, "").trim();
      inToolsList = false;
    } else if (line.startsWith("description:")) {
      description = line.replace(/^description:\s*/, "").replace(/^["']|["']$/g, "").trim();
      inToolsList = false;
    } else if (line.startsWith("tools:")) {
      const rest = line.replace(/^tools:\s*/, "").trim();
      if (rest.startsWith("[") && rest.endsWith("]")) {
        // Inline JSON array format: ["Read", "Write"]
        try {
          tools = JSON.parse(rest);
        } catch {
          tools = rest.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        }
      } else {
        tools = [];
        inToolsList = true;
      }
    } else if (inToolsList && line.startsWith("-")) {
      const tool = line.replace(/^-\s*/, "").replace(/^["']|["']$/g, "").trim();
      if (tool) tools?.push(tool);
    } else {
      inToolsList = false;
    }
  }

  if (!description) return null;

  return {
    name,
    description,
    tools,
    instructions,
    filePath,
  };
}

// Recursively load all SKILL.md files
export function loadAllSkills(dir: string = SKILLS_DIR): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: Skill[] = [];

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const parsed = parseSkillMarkdown(content, fullPath);
          if (parsed) skills.push(parsed);
        } catch (e: any) {
          process.stderr.write(`[Skills] Failed to load ${fullPath}: ${e.message}\n`);
        }
      }
    }
  }

  scan(dir);
  return skills;
}

// Find matching skill based on user prompt keywords and description intent
export function matchSkill(prompt: string, skills: Skill[]): Skill | null {
  if (!prompt || skills.length === 0) return null;

  const lowerPrompt = prompt.toLowerCase();

  for (const skill of skills) {
    const lowerName = skill.name.toLowerCase();

    // Direct name match or keyword hints
    if (lowerPrompt.includes(lowerName)) return skill;

    // Check specific intent keywords based on skill name
    if (lowerName === "code-reviewer" && /\b(review|audit|critique|code review)\b/i.test(lowerPrompt)) {
      return skill;
    }
    if (lowerName === "code-translator" && /\b(translate|convert|port|rewrite in)\b/i.test(lowerPrompt)) {
      return skill;
    }
  }

  return null;
}
