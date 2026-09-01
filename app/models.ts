import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

// Constants
export const MODELS_CONFIG_PATH = path.resolve(
  process.cwd(),
  ".agents",
  "models.json",
);

const OLLAMA_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.replace(/\/v1\/?$/, "") ??
  "http://localhost:11434";

// Types
export type ModelInfo = {
  id: string;
  name: string;
  creator: string;
  license: string;
  alias?: string;
  aliases: string[];
  description: string;
  capabilities: string[];
  vramUsage: string;
};

export type ModelsConfigFile = {
  defaultModel?: string;
  models?: any[];
};

// Fallback models when .agents/models.json is missing
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "granite4.2:3b",
    name: "IBM Granite 4.2 3B",
    creator: "IBM Research",
    license: "Apache 2.0",
    aliases: ["granite", "granite4.2", "granite:3b", "ibm", "granite42"],
    description: "Compact enterprise reasoning model optimized for tool calling, coding, and multilingual tasks.",
    capabilities: ["Tool Use", "Reasoning", "Coding", "Structured Output"],
    vramUsage: "~2.2 GB VRAM",
  },
  {
    id: "qwen2.5-coder:7b-instruct-q3_k_m",
    name: "Qwen 2.5 Coder 7B Instruct",
    creator: "Alibaba Qwen",
    license: "Apache 2.0",
    aliases: ["qwen", "qwen2.5", "qwen2.5coder", "qwencoder", "qwen-coder", "coder"],
    description: "Code-specialized 7B instruction model designed for deep code synthesis and refactoring.",
    capabilities: ["Deep Code Synthesis", "Debugging", "Refactoring", "Code Translation"],
    vramUsage: "~3.8 GB VRAM",
  },
];

// Load models dynamically from .agents/models.json with full normalization
export function loadRegisteredModels(): ModelInfo[] {
  if (fs.existsSync(MODELS_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(MODELS_CONFIG_PATH, "utf-8");
      const parsed: ModelsConfigFile = JSON.parse(raw);
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        return parsed.models.map((m: any) => ({
          id: m.id ?? "",
          name: m.name ?? m.id ?? "Unknown Model",
          creator: m.creator ?? "Unknown",
          license: m.license ?? "Unknown",
          aliases: Array.isArray(m.aliases)
            ? m.aliases
            : typeof m.alias === "string"
              ? [m.alias]
              : [],
          description:
            m.description ??
            (Array.isArray(m.capabilities)
              ? m.capabilities.slice(0, 4).join(" · ")
              : "Local LLM"),
          capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
          vramUsage: m.vramUsage ?? "Installed in local Ollama",
        }));
      }
    } catch {
      // Fallback
    }
  }
  return FALLBACK_MODELS;
}

// Active model registry
export const REGISTERED_MODELS: ModelInfo[] = loadRegisteredModels();

// Fallback default model ID
export const DEFAULT_MODEL_ID = "qwen2.5-coder:7b-instruct-q3_k_m";

// Resolve model alias or return custom model info
export function resolveModel(input: string): ModelInfo {
  const normalized = input.trim().toLowerCase();
  const models = loadRegisteredModels();

  // Match by registered alias or exact ID
  for (const model of models) {
    if (model.id.toLowerCase() === normalized) return model;
    if (
      Array.isArray(model.aliases) &&
      model.aliases.some((a) => a.toLowerCase() === normalized)
    ) {
      return model;
    }
  }

  // Fallback info for custom/external model strings
  return {
    id: input.trim(),
    name: input.trim(),
    creator: "Custom / External",
    license: "Unknown",
    aliases: [],
    description: "Custom model configuration",
    capabilities: ["Text Generation", "Tool Calling"],
    vramUsage: "Variable",
  };
}

// Interactive Model Picker with Arrow Key Navigation & Enter selection
export async function promptSelectModel(currentModelId: string): Promise<ModelInfo> {
  const models = loadRegisteredModels();
  if (models.length === 0 || !process.stdin.isTTY) {
    return resolveModel(currentModelId);
  }

  const boldCyan = (s: string) => `\x1b[1;36m${s}\x1b[0m`;
  const boldGreen = (s: string) => `\x1b[1;32m${s}\x1b[0m`;
  const boldYellow = (s: string) => `\x1b[1;33m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  let selectedIndex = models.findIndex(
    (m) =>
      m.id.toLowerCase() === currentModelId.toLowerCase() ||
      (Array.isArray(m.aliases) &&
        m.aliases.some((a) => a.toLowerCase() === currentModelId.toLowerCase())),
  );
  if (selectedIndex === -1) selectedIndex = 0;

  let renderedLines = 0;

  process.stdout.write(
    `\n  ${boldYellow("🤖 Select AI Model")}\n` +
      `  ${gray("Use ↑/↓ arrows to navigate, Enter to select:")}\n`,
  );

  function renderMenu() {
    if (renderedLines > 0) {
      process.stdout.write(`\x1b[${renderedLines}A\r`);
      for (let i = 0; i < renderedLines; i++) {
        process.stdout.write("\x1b[2K\n");
      }
      process.stdout.write(`\x1b[${renderedLines}A\r`);
    }

    const lines: string[] = [];
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const isSelected = i === selectedIndex;
      const isActive =
        m.id.toLowerCase() === currentModelId.toLowerCase() ||
        (Array.isArray(m.aliases) &&
          m.aliases.some((a) => a.toLowerCase() === currentModelId.toLowerCase()));
      const activeBadge = isActive ? boldGreen(" [ACTIVE]") : "";
      const aliasTag = m.aliases && m.aliases[0] ? gray(` (-m ${m.aliases[0]})`) : "";

      if (isSelected) {
        lines.push(`  ${cyan("❯")} ${boldCyan(`● ${m.name}`)}${aliasTag}${activeBadge}`);
        lines.push(`    ${gray(m.description)}`);
      } else {
        lines.push(`    ${dim(`○ ${m.name}`)}${aliasTag}${activeBadge}`);
        lines.push(`    ${dim(m.description)}`);
      }
    }

    process.stdout.write(lines.join("\n") + "\n");
    renderedLines = lines.length;
  }

  renderMenu();

  return new Promise<ModelInfo>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw ?? false);
    };

    const handleSelect = (idx: number) => {
      cleanup();
      const chosen = models[idx];
      process.stdout.write(
        `\n  ✨ Switched to: ${boldCyan(chosen.name)} ${gray(`(${chosen.id})`)}\n\n`,
      );
      resolve(chosen);
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(0);
      }

      if (key.name === "up" || key.name === "k") {
        selectedIndex = (selectedIndex - 1 + models.length) % models.length;
        renderMenu();
      } else if (key.name === "down" || key.name === "j") {
        selectedIndex = (selectedIndex + 1) % models.length;
        renderMenu();
      } else if (
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "space"
      ) {
        handleSelect(selectedIndex);
      } else if (key.name === "escape" || key.name === "q") {
        cleanup();
        process.stdout.write("\n  " + gray("Model selection unchanged.\n\n"));
        resolve(resolveModel(currentModelId));
      } else if (key.name && /^[1-9]$/.test(key.name)) {
        const num = parseInt(key.name, 10) - 1;
        if (num < models.length) {
          handleSelect(num);
        }
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// Load default model from .agents/models.json if exists
export function loadModelConfigFile(): ModelsConfigFile {
  if (!fs.existsSync(MODELS_CONFIG_PATH)) return {};
  try {
    const raw = fs.readFileSync(MODELS_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Determine active model following strict configuration precedence
// Precedence: 1. CLI flag (-m/--model) -> 2. REPL in-memory -> 3. .agents/models.json -> 4. .env -> 5. DEFAULT_MODEL_ID
export function determineActiveModel(cliModel?: string): string {
  if (cliModel && cliModel.trim()) {
    return resolveModel(cliModel).id;
  }

  const configFile = loadModelConfigFile();
  if (configFile.defaultModel && configFile.defaultModel.trim()) {
    return resolveModel(configFile.defaultModel).id;
  }

  if (process.env.MODEL && process.env.MODEL.trim()) {
    return resolveModel(process.env.MODEL).id;
  }

  return DEFAULT_MODEL_ID;
}

// Check installed models in local Ollama instance
export async function getInstalledOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: "GET" });
    if (!res.ok) return [];
    const data: any = await res.json();
    if (Array.isArray(data.models)) {
      return data.models.map((m: any) => m.name);
    }
    return [];
  } catch {
    return [];
  }
}

// Validate model availability against local Ollama
export async function validateModelAvailability(modelId: string): Promise<{
  installed: boolean;
  installedModels: string[];
}> {
  const installedModels = await getInstalledOllamaModels();
  if (installedModels.length === 0) {
    return { installed: true, installedModels: [] };
  }

  const target = modelId.toLowerCase();
  const isInstalled = installedModels.some(
    (m) =>
      m.toLowerCase() === target ||
      m.toLowerCase().startsWith(target.split(":")[0]),
  );

  return {
    installed: isInstalled,
    installedModels,
  };
}
