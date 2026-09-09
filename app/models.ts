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
    id: "PetrosStav/gemma3-tools:4b",
    name: "Gemma 3 Tools 4B",
    creator: "PetrosStav / Google",
    license: "Gemma Terms of use",
    aliases: ["gemma", "gemma3", "gemma:4b", "gemma3-tools", "google"],
    description: "Google DeepMind multimodal tool model with native vision and function calling.",
    capabilities: ["Vision / Image Understanding", "Tool Use", "Function Calling", "Reasoning"],
    vramUsage: "~3.3 GB VRAM",
  },
  {
    id: "ministral-3:3b",
    name: "Mistral Ministral 3 3B",
    creator: "Mistral AI",
    license: "Apache 2.0",
    aliases: ["ministral", "ministral3", "ministral-3:3b", "mistral"],
    description: "High-speed instruction model optimized for fast tool execution, vision, and concise reasoning.",
    capabilities: ["Vision / Image Understanding", "Tool Use", "Speed", "Reasoning", "Structured Output"],
    vramUsage: "~3.0 GB VRAM",
  },
  {
    id: "lfm2.5:8b",
    name: "Liquid LFM 2.5 8B A1B",
    creator: "Liquid AI",
    license: "LFM 1.0",
    aliases: ["lfm", "lfm2.5", "liquid", "lfm:8b"],
    description: "Liquid neural state-space model for low-latency agentic workflows and tool chaining.",
    capabilities: ["Tool Use", "Function Calling", "Agentic Workflows", "Low-Latency Inference"],
    vramUsage: "~5.2 GB VRAM",
  },
  {
    id: "qwen3.5:4b",
    name: "Qwen 3.5 4B",
    creator: "Alibaba Qwen",
    license: "Apache 2.0",
    aliases: ["qwen3.5", "qwen", "qwen-3.5", "qwen3.5:4b", "alibaba"],
    description: "Advanced multimodal coding and reasoning model with native vision and document understanding.",
    capabilities: ["Vision / Image Understanding", "Reasoning", "Coding", "Tool Calling"],
    vramUsage: "~3.4 GB VRAM",
  },
  {
    id: "parable/fable:4b",
    name: "Parable Fable 4B",
    creator: "Parable / AnkitAI",
    license: "Apache 2.0",
    aliases: ["fable", "parable", "fable:4b", "parable/fable", "fable4b"],
    description: "Agentic reasoning model trained on Claude Fable & GPT-5.5 tool traces, optimized for <think> planning and coding.",
    capabilities: ["Agentic Reasoning", "Tool Use", "Function Calling", "Planning", "Coding"],
    vramUsage: "~2.5 GB VRAM",
  },
];

// Load models dynamically from .agents/models.json with full normalization
export function loadRegisteredModels(): ModelInfo[] {
  if (fs.existsSync(MODELS_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(MODELS_CONFIG_PATH, "utf-8");
      const parsed: ModelsConfigFile = JSON.parse(raw);
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        return parsed.models.map((m: any) => {
          const aliasList = Array.from(
            new Set([
              ...(Array.isArray(m.aliases) ? m.aliases : []),
              ...(typeof m.alias === "string" ? [m.alias] : []),
            ]),
          );
          return {
            id: m.id ?? "",
            name: m.name ?? m.id ?? "Unknown Model",
            creator: m.creator ?? "Unknown",
            license: m.license ?? "Unknown",
            alias: aliasList[0] ?? "",
            aliases: aliasList,
            description:
              m.description ??
              (Array.isArray(m.capabilities)
                ? m.capabilities.slice(0, 4).join(" · ")
                : "Local LLM"),
            capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
            vramUsage: m.vramUsage ?? "Installed in local Ollama",
          };
        });
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
export const DEFAULT_MODEL_ID = "granite4.2:3b";

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

// Check if model has Vision / Image Understanding capability
export function modelSupportsVision(modelId: string): boolean {
  const info = resolveModel(modelId);
  return (
    Array.isArray(info.capabilities) &&
    info.capabilities.some(
      (c) =>
        c.toLowerCase().includes("vision") || c.toLowerCase().includes("image"),
    )
  );
}

// Format a clean, human-readable catalog of all registered models
export function formatModelsCatalog(): string {
  const models = loadRegisteredModels();
  const currentModelId = process.env.MODEL ?? DEFAULT_MODEL_ID;
  const lines: string[] = [
    `\x1b[1;36m🤖 Installed Local Models (${models.length})\x1b[0m`,
    `\x1b[90mSwitch anytime with: \x1b[1;33m/model <alias>\x1b[90m or \x1b[1;33m/model\x1b[90m (interactive picker)\x1b[0m\n`,
  ];

  for (const m of models) {
    const isActive =
      m.id.toLowerCase() === currentModelId.toLowerCase() ||
      (Array.isArray(m.aliases) &&
        m.aliases.some((a) => a.toLowerCase() === currentModelId.toLowerCase()));
    const status = isActive ? ` \x1b[1;32m[ACTIVE]\x1b[0m` : "";
    const hasVision = modelSupportsVision(m.id);
    const visionTag = hasVision ? ` \x1b[1;35m📷 Vision Enabled\x1b[0m` : ` \x1b[90mText & Code\x1b[0m`;
    const aliasStr =
      m.aliases && m.aliases.length > 0
        ? m.aliases.map((a) => `\x1b[33m${a}\x1b[0m`).join(", ")
        : "none";

    lines.push(`  \x1b[1m${m.name}\x1b[0m \x1b[90m(${m.id})\x1b[0m${status}`);
    lines.push(`    \x1b[90m• Aliases    :\x1b[0m ${aliasStr}`);
    lines.push(`    \x1b[90m• Modality   :\x1b[0m${visionTag} · \x1b[36m${m.vramUsage}\x1b[0m`);
    lines.push(`    \x1b[90m• Strengths  :\x1b[0m \x1b[37m${m.capabilities.slice(0, 5).join(" · ")}\x1b[0m`);
    lines.push("");
  }

  lines.push(`\x1b[1;33m💡 Recommended Choices by Task:\x1b[0m`);
  lines.push(`  • \x1b[1;35mImage Understanding / Vision\x1b[0m: \x1b[1m/model qwen3.5\x1b[0m, \x1b[1m/model gemma\x1b[0m, or \x1b[1m/model ministral\x1b[0m`);
  lines.push(`  • \x1b[1;36mDeep Reasoning & Complex Code\x1b[0m: \x1b[1m/model granite\x1b[0m or \x1b[1m/model qwen3.5\x1b[0m`);
  lines.push(`  • \x1b[1;32mFast Low-Latency Tool Tasks\x1b[0m  : \x1b[1m/model ministral\x1b[0m or \x1b[1m/model lfm\x1b[0m`);

  return lines.join("\n");
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
      process.stdout.write(`\x1b[${renderedLines}A\r\x1b[0J`);
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
      const visionTag = modelSupportsVision(m.id) ? ` \x1b[35m[📷 Vision]\x1b[0m` : "";

      if (isSelected) {
        lines.push(`  ${cyan("❯")} ${boldCyan(`● ${m.name}`)}${aliasTag}${visionTag}${activeBadge}`);
        lines.push(`    ${gray(m.description)}`);
      } else {
        lines.push(`    ${dim(`○ ${m.name}`)}${aliasTag}${visionTag}${activeBadge}`);
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
      if (renderedLines > 0) {
        process.stdout.write(`\x1b[${renderedLines + 3}A\r\x1b[0J`);
      }
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

