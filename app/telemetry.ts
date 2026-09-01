import fs from "node:fs";
import path from "node:path";

// Constants
export const TELEMETRY_DIR = path.resolve(process.cwd(), ".agents", "telemetry");
export const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// Types
export type ModelContextStats = {
  modelContextLength: number; // model's maximum architectural capability (e.g. 131,072)
  configuredContextLength: number; // Ollama num_ctx or active session context budget (e.g. 65,536)
};

export type TurnTelemetryEvent = {
  session_id: string;
  turn: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  context_tokens: number;
  model_context_limit: number;
  configured_context_limit: number;
  ttft_ms: number;
  generation_time_ms: number;
  tokens_per_second: number;
  tool_calls: number;
  tool_time_ms: number;
  errors: number;
  timestamp: string;
};

export type SessionTelemetrySummary = {
  sessionId: string;
  modelName: string;
  durationMs: number;
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  modelContextLimit: number;
  configuredContextLimit: number;
  contextPercent: number;
  remainingTokens: number;
  avgTtftMs: number;
  avgTokensPerSecond: number;
  totalToolCalls: number;
  totalToolTimeMs: number;
  totalErrors: number;
};

// In-memory cache for queried model metadata
const modelContextCache = new Map<string, ModelContextStats>();

// Dynamically query Ollama /api/show for model's true architectural context length & configured num_ctx
export async function fetchModelContextStats(
  modelName: string,
): Promise<ModelContextStats> {
  if (modelContextCache.has(modelName)) {
    return modelContextCache.get(modelName)!;
  }

  // Fallback defaults if Ollama unreachable
  let modelContextLength = 32768;
  let configuredContextLength = process.env.OLLAMA_NUM_CTX
    ? parseInt(process.env.OLLAMA_NUM_CTX, 10)
    : 32768;

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
    });

    if (res.ok) {
      const data: any = await res.json();

      // 1. Extract architectural context length from model_info
      if (data.model_info && typeof data.model_info === "object") {
        for (const [key, val] of Object.entries(data.model_info)) {
          if (key.endsWith(".context_length") && typeof val === "number") {
            modelContextLength = val;
            break;
          }
        }
      }

      // 2. Extract configured num_ctx from parameters (if set in Modelfile)
      if (typeof data.parameters === "string") {
        const numCtxMatch = data.parameters.match(/num_ctx\s+(\d+)/i);
        if (numCtxMatch && numCtxMatch[1]) {
          configuredContextLength = parseInt(numCtxMatch[1], 10);
        } else {
          // If no custom num_ctx specified, default to env or model capability
          configuredContextLength = process.env.OLLAMA_NUM_CTX
            ? parseInt(process.env.OLLAMA_NUM_CTX, 10)
            : Math.min(modelContextLength, 65536);
        }
      } else {
        configuredContextLength = process.env.OLLAMA_NUM_CTX
          ? parseInt(process.env.OLLAMA_NUM_CTX, 10)
          : Math.min(modelContextLength, 65536);
      }
    }
  } catch {
    // Graceful fallback to default
  }

  const result: ModelContextStats = {
    modelContextLength,
    configuredContextLength,
  };

  modelContextCache.set(modelName, result);
  return result;
}

// Estimate token count from text (~3.8 characters per token for code/text)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

// Estimate tokens for message array
export function estimateMessagesTokens(messages: any[]): number {
  let count = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      count += estimateTokens(m.content);
    }
    if (m.tool_calls) {
      count += estimateTokens(JSON.stringify(m.tool_calls));
    }
  }
  return count;
}

// Record structured telemetry event to .agents/telemetry/<session_id>.jsonl
export function recordTurnTelemetry(event: TurnTelemetryEvent): void {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    }
    const filePath = path.join(TELEMETRY_DIR, `${event.session_id}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
  } catch (e: any) {
    process.stderr.write(`[Telemetry] Failed to record event: ${e.message}\n`);
  }
}

// Load all events for a session
export function loadSessionTelemetry(sessionId: string): TurnTelemetryEvent[] {
  const filePath = path.join(TELEMETRY_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Compute aggregate session summary
export function aggregateSessionTelemetry(
  sessionId: string,
  sessionStartTime: number = Date.now(),
): SessionTelemetrySummary {
  const events = loadSessionTelemetry(sessionId);
  const durationMs = Math.max(0, Date.now() - sessionStartTime);

  if (events.length === 0) {
    return {
      sessionId,
      modelName: process.env.MODEL ?? "local-model",
      durationMs,
      turns: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      modelContextLimit: 131072,
      configuredContextLimit: 65536,
      contextPercent: 0,
      remainingTokens: 65536,
      avgTtftMs: 0,
      avgTokensPerSecond: 0,
      totalToolCalls: 0,
      totalToolTimeMs: 0,
      totalErrors: 0,
    };
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalToolCalls = 0;
  let totalToolTimeMs = 0;
  let totalGenTimeMs = 0;
  let totalErrors = 0;
  let sumTtft = 0;
  let sumTps = 0;
  let latestContextTokens = 0;
  let latestModelLimit = 131072;
  let latestConfiguredLimit = 65536;
  let modelName = process.env.MODEL ?? "local-model";

  for (const ev of events) {
    totalInput += ev.input_tokens;
    totalOutput += ev.output_tokens;
    totalToolCalls += ev.tool_calls;
    totalToolTimeMs += ev.tool_time_ms;
    totalGenTimeMs += ev.generation_time_ms ?? 0;
    totalErrors += ev.errors;
    sumTtft += ev.ttft_ms;
    sumTps += ev.tokens_per_second;
    latestContextTokens = ev.context_tokens;
    latestModelLimit = ev.model_context_limit;
    latestConfiguredLimit = ev.configured_context_limit;
    if (ev.model) modelName = ev.model;
  }

  const computedActiveMs = totalGenTimeMs + totalToolTimeMs;
  const finalDurationMs =
    sessionStartTime && Date.now() - sessionStartTime > 500
      ? Date.now() - sessionStartTime
      : computedActiveMs > 0
        ? computedActiveMs
        : durationMs;

  const turns = events.length;
  const contextPercent = Math.min(
    100,
    Math.round((latestContextTokens / (latestConfiguredLimit || 65536)) * 100),
  );
  const remainingTokens = Math.max(0, latestConfiguredLimit - latestContextTokens);

  return {
    sessionId,
    modelName,
    durationMs: finalDurationMs,
    turns,
    totalTokens: totalInput + totalOutput,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    contextTokens: latestContextTokens,
    modelContextLimit: latestModelLimit,
    configuredContextLimit: latestConfiguredLimit,
    contextPercent,
    remainingTokens,
    avgTtftMs: Math.round(sumTtft / turns),
    avgTokensPerSecond: Math.round((sumTps / turns) * 10) / 10,
    totalToolCalls,
    totalToolTimeMs,
    totalErrors,
  };
}

// Format duration helper (e.g. "12m 34s" or "4.2s")
export function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// Strip ANSI escape codes to calculate visible string length
function visibleLen(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Render ASCII/Unicode progress bar (e.g. "████████████░░░░░░░░  64%")
export function renderProgressBar(
  current: number,
  max: number,
  barLength: number = 20,
): string {
  const percent = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
  const empty = barLength - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)}  ${percent}%`;
}

// Format styled box with separated model context limit vs. configured context
export function formatTelemetryBox(summary: SessionTelemetrySummary): string {
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

  const INNER_WIDTH = 44;

  const pad = (label: string, value: string): string => {
    const len = visibleLen(label) + visibleLen(value);
    const spaces = Math.max(1, INNER_WIDTH - len);
    return `│ ${label}${" ".repeat(spaces)}${value} │`;
  };

  const padRaw = (content: string): string => {
    const len = visibleLen(content);
    const spaces = Math.max(0, INNER_WIDTH - len);
    return `│ ${content}${" ".repeat(spaces)} │`;
  };

  const durStr = formatDuration(summary.durationMs);
  const tokensStr = summary.totalTokens.toLocaleString();
  const ttftStr = `${(summary.avgTtftMs / 1000).toFixed(2)}s`;
  const tpsStr = `${summary.avgTokensPerSecond.toFixed(1)} tok/s`;
  const toolTimeStr = `${(summary.totalToolTimeMs / 1000).toFixed(1)}s`;
  const progressBar = renderProgressBar(
    summary.contextTokens,
    summary.configuredContextLimit,
    18,
  );
  const contextFraction = `${summary.contextTokens.toLocaleString()} / ${summary.configuredContextLimit.toLocaleString()} tokens`;

  return [
    `╭────────────── ${bold(cyan("Agent Telemetry"))} ──────────────╮`,
    pad("Model", summary.modelName),
    pad("Session", durStr),
    pad("Turns", String(summary.turns)),
    pad("Tokens", tokensStr),
    padRaw(""),
    padRaw(bold("Context Budget:")),
    padRaw(`  ${cyan(progressBar)}`),
    padRaw(`  ${dim(contextFraction)}`),
    padRaw(""),
    pad("Model context limit", summary.modelContextLimit.toLocaleString()),
    pad("Configured context", summary.configuredContextLimit.toLocaleString()),
    pad("Current usage", summary.contextTokens.toLocaleString()),
    pad("Remaining", summary.remainingTokens.toLocaleString()),
    padRaw(""),
    pad("TTFT", ttftStr),
    pad("Generation", tpsStr),
    pad("Tool calls", String(summary.totalToolCalls)),
    pad("Tool time", toolTimeStr),
    pad("Errors", String(summary.totalErrors)),
    `╰────────────────────────────────────────────╯`,
  ].join("\n");
}
