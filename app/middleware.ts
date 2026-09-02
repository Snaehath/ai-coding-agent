import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface AgentRequestContext {
  sessionId: string;
  prompt: string;
  messages: any[];
  tools: any[];
  model: string;
  thinkingEffort?: string;
  metadata: Record<string, any>;
  shortCircuitResponse?: string;
}

export interface AgentResponseContext {
  sessionId: string;
  rawResponse: string;
  cleanedResponse: string;
  model: string;
  turns: number;
  metadata: Record<string, any>;
}

export interface AgentMiddleware {
  name: string;
  description?: string;
  priority?: number; // 0 (highest/outermost) to 100 (lowest/innermost)
  enabled?: boolean;
  beforeRequest?(ctx: AgentRequestContext): Promise<AgentRequestContext | void> | AgentRequestContext | void;
  afterResponse?(ctx: AgentResponseContext): Promise<AgentResponseContext | void> | AgentResponseContext | void;
}

export const MIDDLEWARE_DIR = path.resolve(process.cwd(), ".agents", "middleware");

export class MiddlewarePipeline {
  private middlewares: AgentMiddleware[] = [];

  constructor() {
    this.registerBuiltinMiddlewares();
  }

  // Register a middleware instance
  use(middleware: AgentMiddleware): this {
    this.middlewares.push({
      priority: 50,
      enabled: true,
      ...middleware,
    });
    this.sort();
    return this;
  }

  // Get all registered middlewares
  list(): AgentMiddleware[] {
    return [...this.middlewares];
  }

  // Sort by priority (ascending for request, reversed for response)
  private sort() {
    this.middlewares.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  }

  // Register default built-in middlewares
  private registerBuiltinMiddlewares() {
    // 1. Security & Redaction Middleware
    this.use({
      name: "security",
      description: "Sanitizes sensitive patterns and redacts exposed credentials from model responses",
      priority: 10,
      beforeRequest: (ctx) => {
        // Prevent prompt injection attempts aiming to bypass path guardrails
        if (typeof ctx.prompt === "string" && /ignore\s+previous\s+instructions/i.test(ctx.prompt)) {
          ctx.messages.unshift({
            role: "system",
            content: "[Security Guardrail Notice]: Standard security and safety boundaries remain strictly enforced.",
          });
        }
      },
      afterResponse: (ctx) => {
        // Redact common secret key signatures from final output
        ctx.cleanedResponse = ctx.cleanedResponse
          .replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/g, "[REDACTED_GITHUB_TOKEN]")
          .replace(/sk-[A-Za-z0-9]{32,}/g, "[REDACTED_OPENAI_KEY]")
          .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]");
      },
    });

    // 2. Telemetry & Timing Middleware
    this.use({
      name: "telemetry",
      description: "Tracks request start timestamps and enriches response metadata",
      priority: 20,
      beforeRequest: (ctx) => {
        ctx.metadata.startTime = performance.now();
      },
      afterResponse: (ctx) => {
        if (ctx.metadata.startTime) {
          ctx.metadata.durationMs = Math.round(performance.now() - ctx.metadata.startTime);
        }
      },
    });

    // 3. Response Sanitizer Middleware
    this.use({
      name: "sanitizer",
      description: "Strips leftover internal tool call fragments and whitespace from outputs",
      priority: 90,
      afterResponse: (ctx) => {
        if (ctx.cleanedResponse) {
          ctx.cleanedResponse = ctx.cleanedResponse.trim();
        }
      },
    });
  }

  // Load user-defined middlewares from .agents/middleware/*.ts
  async loadUserMiddlewares(customDir: string = MIDDLEWARE_DIR): Promise<number> {
    if (!fs.existsSync(customDir)) {
      try {
        fs.mkdirSync(customDir, { recursive: true });
      } catch {
        /* ignore */
      }
      return 0;
    }

    let loadedCount = 0;
    const files = fs.readdirSync(customDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

    for (const file of files) {
      try {
        const fullPath = path.join(customDir, file);
        const modUrl = pathToFileURL(fullPath).href;
        const mod = await import(modUrl);
        const middleware: AgentMiddleware = mod.default || mod.middleware;

        if (middleware && typeof middleware === "object" && middleware.name) {
          this.use(middleware);
          loadedCount++;
        }
      } catch (e: any) {
        process.stderr.write(`[Middleware] Warning: Failed to load "${file}": ${e.message}\n`);
      }
    }

    this.sort();
    return loadedCount;
  }

  // Execute beforeRequest pipeline (ascending priority)
  async executeBeforeRequest(initialCtx: AgentRequestContext): Promise<AgentRequestContext> {
    let ctx = { ...initialCtx };

    for (const m of this.middlewares) {
      if (m.enabled === false || !m.beforeRequest) continue;
      try {
        const res = await m.beforeRequest(ctx);
        if (res && typeof res === "object") {
          ctx = res;
        }
        // If short-circuited, break pipeline early
        if (ctx.shortCircuitResponse) {
          break;
        }
      } catch (e: any) {
        process.stderr.write(`[Middleware] Error in "${m.name}.beforeRequest": ${e.message}\n`);
      }
    }

    return ctx;
  }

  // Execute afterResponse pipeline (descending priority - onion model)
  async executeAfterResponse(initialCtx: AgentResponseContext): Promise<AgentResponseContext> {
    let ctx = { ...initialCtx };
    const reversed = [...this.middlewares].reverse();

    for (const m of reversed) {
      if (m.enabled === false || !m.afterResponse) continue;
      try {
        const res = await m.afterResponse(ctx);
        if (res && typeof res === "object") {
          ctx = res;
        }
      } catch (e: any) {
        process.stderr.write(`[Middleware] Error in "${m.name}.afterResponse": ${e.message}\n`);
      }
    }

    return ctx;
  }
}

// Global Singleton Pipeline
export const middlewarePipeline = new MiddlewarePipeline();
