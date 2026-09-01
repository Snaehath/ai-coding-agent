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

    aliases: [
      "granite",
      "granite4.2",
      "granite:3b",
      "granite4.2:3b",
      "ibm",
      "granite42",
    ],

    description:
      "Compact enterprise-oriented reasoning model optimized for tool calling, agent workflows, coding, structured outputs, multilingual tasks, and long-context reasoning.",

    capabilities: [
      "Tool Use",
      "Thinking / Reasoning",
      "Reasoning-Augmented Tool Calling",
      "RAG",
      "Coding & Refactoring",
      "Structured JSON Output",
      "Agentic Workflows",
      "Multilingual Tasks",
      "Long Context",
      "Instruction Following",
    ],

    vramUsage:
      "~2.2 GB VRAM for the installed Ollama quantization; additional memory is required for context/KV cache",
  },
  {
    id: "qwen2.5-coder:7b-instruct-q3_k_m",

    name: "Qwen 2.5 Coder 7B Instruct",

    creator: "Alibaba Qwen",

    license: "Apache 2.0",

    aliases: [
      "qwen",
      "qwen2.5",
      "qwen2.5coder",
      "qwencoder",
      "qwen-coder",
      "qwen:7b",
      "coder",
    ],

    description:
      "Code-specialized 7B instruction model designed for code generation, code reasoning, debugging, refactoring, repository understanding, and software engineering tasks.",

    capabilities: [
      "Deep Code Synthesis",
      "Code Completion",
      "Code Reasoning",
      "Bug Detection",
      "Debugging",
      "Refactoring",
      "Multi-file Code Understanding",
      "Code Translation",
      "Algorithm Implementation",
      "Documentation Generation",
      "Technical Q&A",
      "Shell / Automation Code",
    ],

    vramUsage:
      "~3.8 GB VRAM for Q3_K_M weights; additional memory is required for the context/KV cache",
  },
  {
    id: "PetrosStav/gemma3-tools:4b",
    name: "Gemma 3 Tools 4B",
    creator: "PetrosStav / Google",
    license: "Gemma Terms of use",
    aliases: [
      "gemma",
      "gemma3",
      "gemma3:4b",
      "gemma3-tools",
      "gemma-tools",
      "gemma:4b",
    ],

    description:
      "Compact multimodal Gemma 3 model modified for reliable tool calling, suitable for lightweight agents, vision tasks, general chat, and local automation.",

    capabilities: [
      "Tool Use",
      "Function Calling",
      "Vision / Image Understanding",
      "General Chat",
      "Reasoning",
      "Question Answering",
      "Summarization",
      "Multilingual Tasks",
      "Agent Workflows",
      "Long Context",
    ],
    vramUsage:
      "~3.3 GB VRAM for Q4_K_M weights; allow additional VRAM for context/KV cache",
  },
  {
    id: "ministral-3:3b",

    name: "Mistral Ministral 3 3B",

    creator: "Mistral AI",

    license: "Apache 2.0",

    aliases: [
      "ministral",
      "ministral3",
      "ministral-3",
      "ministral:3b",
      "mistral",
      "mistral3",
    ],

    description:
      "Ultra-compact multimodal model optimized for edge deployment, function calling, structured output, long-context workloads, and local AI agents.",

    capabilities: [
      "Tool Use",
      "Function Calling",
      "Structured JSON Output",
      "Vision / Image Understanding",
      "Agentic Workflows",
      "Reasoning",
      "Document Q&A",
      "Multilingual Tasks",
      "Long Context",
      "Instruction Following",
    ],

    vramUsage:
      "~3.0 GB VRAM for Q4_K_M weights; additional memory is required for the KV cache and runtime",
  },
  {
    id: "lfm2.5:8b",

    name: "Liquid LFM2.5 8B A1B",

    creator: "Liquid AI",

    license: "LFM 1.0",

    aliases: [
      "lfm",
      "lfm2",
      "lfm2.5",
      "lfm2.5:8b",
      "lfm2.5-8b",
      "liquid",
    ],

    description:
      "Efficient on-device Mixture-of-Experts model designed for fast agentic workflows, tool calling, instruction following, and low-latency inference.",

    capabilities: [
      "Tool Use",
      "Function Calling",
      "Agentic Workflows",
      "Instruction Following",
      "Multi-Step Tool Chaining",
      "Structured Output",
      "Long Context",
      "On-Device AI",
      "Low-Latency Inference",
      "Multilingual Tasks",
    ],

    vramUsage:
      "~5.2 GB VRAM for the installed Ollama quantization; runtime context/KV cache requires additional memory",
  },
  {
    id: "qwen3.5:4b",

    name: "Qwen 3.5 4B",

    creator: "Alibaba Qwen",

    license: "Apache 2.0",

    aliases: ["qwen3.5", "qwen3", "qwen3.5:4b", "qwen:4b", "qwen35"],

    description:
      "Compact multimodal Qwen model combining vision, reasoning, coding, instruction following, and agentic capabilities with an efficient hybrid architecture.",

    capabilities: [
      "Vision / Image Understanding",
      "Reasoning",
      "Coding",
      "Tool Calling",
      "Agentic Workflows",
      "Multilingual Tasks",
      "Long Context",
      "Instruction Following",
      "Document Understanding",
      "Structured Output",
    ],

    vramUsage:
      "~3.4 GB VRAM for the installed Ollama quantization; actual runtime usage increases with context/KV cache",
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
    (m) =>
      m.toLowerCase() === target ||
      m.toLowerCase().startsWith(target.split(":")[0]),
  );

  return {
    installed: isInstalled,
    installedModels,
  };
}
