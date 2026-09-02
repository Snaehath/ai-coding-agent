import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { loadRegisteredModels } from "./models.ts";
import { loadPermissionConfig } from "./permissions.ts";
import { loadHooksConfig } from "./hooks.ts";
import { loadAllSkills } from "./skills.ts";
import { DEFAULT_IGNORED_DIRS, BINARY_EXTENSIONS } from "./filesystem-tools.ts";

export interface InspectOptions {
  target: "project" | "environment" | "process" | "config" | "directory" | "file";
  path?: string;
}

// 1. Inspect Project (Instant single-shot tech stack & codebase detection)
export function inspectProject(projectRoot: string = process.cwd()): string {
  try {
    const root = path.resolve(process.cwd(), projectRoot);
    if (!fs.existsSync(root)) return `Error: Directory not found: ${projectRoot}`;

    const report: Record<string, string | string[]> = {};

    // Check package.json (Node/Bun ecosystem)
    const pkgPath = path.join(root, "package.json");
    let pkg: any = null;
    if (fs.existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      } catch {
        /* invalid json */
      }
    }

    const allDeps = pkg
      ? {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
          ...(pkg.peerDependencies || {}),
        }
      : {};
    const depKeys = Object.keys(allDeps);

    // Primary Languages
    const languages: string[] = [];
    if (fs.existsSync(path.join(root, "tsconfig.json")) || fs.readdirSync(root).some((f) => f.endsWith(".ts"))) {
      languages.push("TypeScript");
    }
    if (pkg || fs.readdirSync(root).some((f) => f.endsWith(".js") || f.endsWith(".mjs"))) {
      if (!languages.includes("TypeScript")) languages.push("JavaScript");
    }
    if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "Pipfile"))) {
      languages.push("Python");
    }
    if (fs.existsSync(path.join(root, "Cargo.toml"))) languages.push("Rust");
    if (fs.existsSync(path.join(root, "go.mod"))) languages.push("Go");
    if (fs.existsSync(path.join(root, "CMakeLists.txt")) || fs.existsSync(path.join(root, "Makefile"))) languages.push("C/C++");
    if (languages.length > 0) report["Languages"] = languages.join(", ");

    // Runtimes & Package Managers
    const runtimes: string[] = [];
    if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) runtimes.push("Bun");
    else if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) runtimes.push("pnpm (Node.js)");
    else if (fs.existsSync(path.join(root, "yarn.lock"))) runtimes.push("Yarn (Node.js)");
    else if (fs.existsSync(path.join(root, "package-lock.json"))) runtimes.push("npm (Node.js)");
    else if (fs.existsSync(path.join(root, "deno.json")) || fs.existsSync(path.join(root, "deno.jsonc"))) runtimes.push("Deno");
    else if (pkg) runtimes.push("Node.js / Bun");
    if (runtimes.length > 0) report["Runtime & Package Manager"] = runtimes.join(", ");

    // Frameworks & Libraries
    const frameworks: string[] = [];
    if (allDeps["next"]) frameworks.push("Next.js");
    else if (allDeps["react"]) frameworks.push("React");
    if (allDeps["vue"] || allDeps["nuxt"]) frameworks.push("Vue / Nuxt");
    if (allDeps["svelte"] || allDeps["@sveltejs/kit"]) frameworks.push("Svelte / SvelteKit");
    if (allDeps["express"]) frameworks.push("Express");
    if (allDeps["fastify"]) frameworks.push("Fastify");
    if (allDeps["@nestjs/core"]) frameworks.push("NestJS");
    if (allDeps["electron"]) frameworks.push("Electron");
    if (allDeps["tailwindcss"]) frameworks.push("Tailwind CSS");
    if (frameworks.length > 0) report["Frameworks"] = frameworks.join(", ");

    // Testing
    const testFrameworks: string[] = [];
    if (allDeps["vitest"]) testFrameworks.push("Vitest");
    if (allDeps["jest"]) testFrameworks.push("Jest");
    if (allDeps["@playwright/test"]) testFrameworks.push("Playwright");
    if (allDeps["cypress"]) testFrameworks.push("Cypress");
    if (testFrameworks.length > 0) report["Testing"] = testFrameworks.join(", ");

    // Linting & Code Style
    const linters: string[] = [];
    if (allDeps["@biomejs/biome"] || fs.existsSync(path.join(root, "biome.json"))) linters.push("Biome");
    if (allDeps["eslint"] || fs.existsSync(path.join(root, ".eslintrc.json")) || fs.existsSync(path.join(root, "eslint.config.js"))) linters.push("ESLint");
    if (allDeps["prettier"] || fs.existsSync(path.join(root, ".prettierrc"))) linters.push("Prettier");
    if (linters.length > 0) report["Lint & Formatting"] = linters.join(", ");

    // Database & ORM
    const db: string[] = [];
    if (allDeps["prisma"] || fs.existsSync(path.join(root, "prisma"))) db.push("Prisma ORM");
    if (allDeps["drizzle-orm"]) db.push("Drizzle ORM");
    if (allDeps["typeorm"]) db.push("TypeORM");
    if (allDeps["mongoose"]) db.push("MongoDB (Mongoose)");
    if (allDeps["pg"]) db.push("PostgreSQL (pg)");
    if (allDeps["better-sqlite3"] || allDeps["sqlite3"]) db.push("SQLite");
    if (db.length > 0) report["Database / ORM"] = db.join(", ");

    // Key Scripts
    if (pkg && pkg.scripts) {
      report["Key Scripts"] = Object.keys(pkg.scripts).slice(0, 6).map((k) => `bun run ${k}`).join(", ");
    }

    // Git Status
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, stdio: "pipe" }).toString().trim();
      const status = execSync("git status --porcelain", { cwd: root, stdio: "pipe" }).toString().trim();
      const modCount = status ? status.split("\n").length : 0;
      report["Git Status"] = `Branch: ${branch} (${modCount} modified file${modCount === 1 ? "" : "s"})`;
    } catch {
      report["Git Status"] = "Not a git repository or git unavailable";
    }

    // Format output
    const lines = [`📊 Project Introspection [${path.basename(root) || "."}]`];
    for (const [key, value] of Object.entries(report)) {
      lines.push(`  • ${key.padEnd(26)}: ${value}`);
    }

    return lines.join("\n");
  } catch (e: any) {
    return `Error inspecting project: ${e.message}`;
  }
}

// 2. Inspect File
export function inspectFile(filePath: string): string {
  try {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) return `Error: File not found: ${filePath}`;

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return inspectDirectory(filePath);

    const ext = path.extname(resolved).toLowerCase();
    const sizeKB = (stat.size / 1024).toFixed(1);
    let lineCount = 0;
    let previewLines = "";

    if (!BINARY_EXTENSIONS.has(ext)) {
      const content = fs.readFileSync(resolved, "utf-8");
      const lines = content.split(/\r?\n/);
      lineCount = lines.length;
      previewLines = lines.slice(0, 5).join("\n");
    }

    return [
      `📄 File Introspection [${path.basename(resolved)}]`,
      `  • Path                     : ${resolved}`,
      `  • Size                     : ${stat.size} bytes (${sizeKB} KB)`,
      `  • Extension                : ${ext || "(none)"}`,
      `  • Line Count               : ${lineCount > 0 ? lineCount : "Binary / N/A"}`,
      `  • Modified Time            : ${stat.mtime.toISOString()}`,
      `  • Read/Write Access        : ${stat.mode.toString(8)}`,
      ...(previewLines ? [`\n  Preview (first lines):\n${previewLines.split("\n").map((l) => `    │ ${l}`).join("\n")}`] : []),
    ].join("\n");
  } catch (e: any) {
    return `Error inspecting file ${filePath}: ${e.message}`;
  }
}

// 3. Inspect Directory
export function inspectDirectory(dirPath: string = "."): string {
  try {
    const resolved = path.resolve(process.cwd(), dirPath);
    if (!fs.existsSync(resolved)) return `Error: Directory not found: ${dirPath}`;

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    let fileCount = 0;
    let dirCount = 0;
    const extBreakdown: Record<string, number> = {};

    for (const e of entries) {
      if (DEFAULT_IGNORED_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        dirCount++;
      } else if (e.isFile()) {
        fileCount++;
        const ext = path.extname(e.name).toLowerCase() || "(no ext)";
        extBreakdown[ext] = (extBreakdown[ext] || 0) + 1;
      }
    }

    const topExtensions = Object.entries(extBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ");

    return [
      `📂 Directory Introspection [${path.basename(resolved) || "."}]`,
      `  • Path                     : ${resolved}`,
      `  • Subdirectories           : ${dirCount}`,
      `  • Files (top-level)        : ${fileCount}`,
      `  • File Types Breakdown     : ${topExtensions || "None"}`,
    ].join("\n");
  } catch (e: any) {
    return `Error inspecting directory ${dirPath}: ${e.message}`;
  }
}

// 4. Inspect Process
export function inspectProcess(): string {
  try {
    const mem = process.memoryUsage();
    return [
      `⚙️ Process Introspection`,
      `  • PID                      : ${process.pid}`,
      `  • Platform / Architecture  : ${process.platform} (${process.arch})`,
      `  • Runtime Version          : Bun ${typeof Bun !== "undefined" ? Bun.version : "N/A"} (Node ${process.version})`,
      `  • Process Uptime           : ${(process.uptime()).toFixed(1)}s`,
      `  • Memory (RSS)             : ${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
      `  • Memory (Heap Used)       : ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      `  • Working Directory        : ${process.cwd()}`,
    ].join("\n");
  } catch (e: any) {
    return `Error inspecting process: ${e.message}`;
  }
}

// 5. Inspect Environment
export function inspectEnvironment(): string {
  try {
    const toolsToCheck = ["bun", "node", "npm", "git", "python", "ollama", "docker", "cargo", "go"];
    const availableTools: string[] = [];

    for (const tool of toolsToCheck) {
      try {
        const cmd = process.platform === "win32" ? `where ${tool}` : `which ${tool}`;
        execSync(cmd, { stdio: "ignore" });
        availableTools.push(tool);
      } catch {
        /* not in path */
      }
    }

    const activeEnvKeys = Object.keys(process.env)
      .filter((k) => !k.startsWith("="))
      .sort()
      .slice(0, 15);

    return [
      `🌐 Environment Introspection`,
      `  • Operating System         : ${os.type()} ${os.release()} (${os.arch()})`,
      `  • Hostname                 : ${os.hostname()}`,
      `  • CPU Cores                : ${os.cpus().length} cores (${os.cpus()[0]?.model || "Unknown"})`,
      `  • Total System Memory      : ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB (Free: ${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB)`,
      `  • Shell Tools in PATH      : ${availableTools.join(", ")}`,
      `  • Active Environment Vars  : ${activeEnvKeys.join(", ")} ... (${Object.keys(process.env).length} total)`,
    ].join("\n");
  } catch (e: any) {
    return `Error inspecting environment: ${e.message}`;
  }
}

// 6. Inspect Agent Configuration
export function inspectConfig(): string {
  try {
    const models = loadRegisteredModels();
    const perms = loadPermissionConfig();
    const hooks = loadHooksConfig();
    const skills = loadAllSkills();

    const activeModel = process.env.MODEL || (models[0]?.id ?? "default");

    return [
      `🛠️ Agent Configuration Introspection`,
      `  • Active Model             : ${activeModel}`,
      `  • Registered Models (${models.length})  : ${models.map((m) => m.name).join(", ")}`,
      `  • Permission Rules (${perms.rules.length})   : Default Action: ${perms.defaultAction}`,
      `  • Registered Skills (${skills.length})  : ${skills.map((s) => s.name).join(", ") || "None"}`,
      `  • Pre-Tool Hooks           : ${(hooks.pre_tool_call || []).length} configured`,
      `  • Post-Tool Hooks          : ${(hooks.post_tool_call || []).length} configured`,
      `  • Session-End Hooks        : ${(hooks.on_session_end || []).length} configured`,
    ].join("\n");
  } catch (e: any) {
    return `Error inspecting configuration: ${e.message}`;
  }
}

// Universal Introspection Router
export function executeInspect(targetOrArgs: string | InspectOptions = "project", targetPath?: string): string {
  let target = "project";
  let searchPath = targetPath;

  if (typeof targetOrArgs === "object" && targetOrArgs !== null) {
    target = (targetOrArgs.target || "project").toLowerCase();
    searchPath = targetOrArgs.path || targetPath;
  } else if (typeof targetOrArgs === "string") {
    target = targetOrArgs.toLowerCase().trim();
  }

  switch (target) {
    case "project":
    case "repo":
    case "codebase":
      return inspectProject(searchPath || process.cwd());

    case "file":
      return inspectFile(searchPath || "package.json");

    case "directory":
    case "dir":
    case "folder":
      return inspectDirectory(searchPath || ".");

    case "process":
    case "proc":
      return inspectProcess();

    case "environment":
    case "env":
    case "system":
    case "os":
      return inspectEnvironment();

    case "config":
    case "configuration":
    case "settings":
    case "agent":
      return inspectConfig();

    default: {
      // If user passed a file path as target (e.g. inspect("app/main.ts"))
      if (fs.existsSync(path.resolve(process.cwd(), target))) {
        return fs.statSync(path.resolve(process.cwd(), target)).isDirectory()
          ? inspectDirectory(target)
          : inspectFile(target);
      }
      return `Unknown inspect target: "${target}". Supported targets: project, file, directory, process, environment, config.`;
    }
  }
}
