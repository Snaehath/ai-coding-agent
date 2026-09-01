import fs from "node:fs";
import path from "node:path";

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
