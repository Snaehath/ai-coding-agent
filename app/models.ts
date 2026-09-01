import fs from "node:fs";
import path from "node:path";

// Constants
export const MODELS_CONFIG_PATH = path.resolve(process.cwd(), ".agents", "models.json");
const OLLAMA_BASE_URL = process.env.OPENROUTER_BASE_URL?.replace(/\/v1\/?$/, "") ?? "http://localhost:11434";

// Types
export type ModelInfo = {
  id: string;
  name: string;
  creator: string;
  license: string;
  aliases: string[];
  description: string;
  capabilities: string[];
  vramUsage: string;
};

// Model registry
export const REGISTERED_MODELS: ModelInfo[] = [
  {
    id: "granite4.2:3b",
    name: "IBM Granite 4.2 3B",
    creator: "IBM Research",
    license: "Apache 2.0",
    aliases: ["granite", "granite4.2", "granite:3b", "granite4.2:3b", "ibm"],
    description: "Lightweight, enterprise-grade model optimized for agent workflows, thinking, and structured JSON output.",
    capabilities: [
      "Tool Use",
      "Thinking / Reasoning",
      "RAG (Retrieval-Augmented Generation)",
      "Coding & Refactoring",
      "Structured JSON Output",
      "Multilingual Tasks",
    ],
    vramUsage: "~2.2 GB VRAM (Super-fast, ideal for low latency)",
  },
  {
    id: "qwen2.5-coder:7b-instruct-q3_k_m",
    name: "Qwen 2.5 Coder 7B Instruct",
    creator: "Alibaba Qwen",
    license: "Apache 2.0",
    aliases: ["qwen", "qwen2.5", "qwen2.5coder", "qwencoder", "qwen:7b", "coder"],
    description: "High-capacity code intelligence model specialized in deep codebase comprehension, bug fixing, and language translation.",
    capabilities: [
      "Deep Code Synthesis",
      "Complex Multi-file Reasoning",
      "Bug Detection & Security Audit",
      "Language-to-Language Translation",
      "Tool Calling & Bash Automation",
    ],
    vramUsage: "~3.8 GB VRAM (Fits 100% in 4GB GPU memory)",
  },
];

// Fallback default
export const DEFAULT_MODEL_ID = "qwen2.5-coder:7b-instruct-q3_k_m";

// Resolve model alias or return raw name
export function resolveModel(input: string): ModelInfo {
  const normalized = input.trim().toLowerCase();

  // Match by registered alias or exact ID
  for (const model of REGISTERED_MODELS) {
    if (model.id.toLowerCase() === normalized) return model;
    if (model.aliases.some((a) => a.toLowerCase() === normalized)) return model;
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
export function loadModelConfigFile(): { defaultModel?: string } {
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
    // Cannot reach Ollama or using non-Ollama backend
    return { installed: true, installedModels: [] };
  }

  const target = modelId.toLowerCase();
  const isInstalled = installedModels.some(
    (m) => m.toLowerCase() === target || m.toLowerCase().startsWith(target.split(":")[0]),
  );

  return {
    installed: isInstalled,
    installedModels,
  };
}
