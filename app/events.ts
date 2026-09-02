import { EventEmitter } from "node:events";

// Strongly-typed Agent Event Definitions
export type AgentEvent =
  | {
      type: "session.started";
      sessionId: string;
      model: string;
      timestamp: string;
    }
  | {
      type: "session.ended";
      sessionId: string;
      model: string;
      totalTurns: number;
      durationSec: number;
      totalTokens: number;
      actionsCount: number;
      errorsCount: number;
      timestamp: string;
    }
  | {
      type: "model.started";
      sessionId: string;
      turn: number;
      model: string;
      prompt: string;
      thinkingEffort?: string;
      timestamp: string;
    }
  | {
      type: "model.completed";
      sessionId: string;
      turn: number;
      model: string;
      ttftMs: number;
      generationTimeMs: number;
      tokensPerSecond: number;
      inputTokens: number;
      outputTokens: number;
      contextTokens: number;
      timestamp: string;
    }
  | {
      type: "token.streamed";
      sessionId: string;
      token: string;
      isReasoning?: boolean;
      timestamp: string;
    }
  | {
      type: "thinking.stage";
      sessionId: string;
      stage: string;
      elapsedSec: number;
      timestamp: string;
    }
  | {
      type: "tool.started";
      sessionId: string;
      toolName: string;
      args: Record<string, any>;
      summary: string;
      target: string;
      timestamp: string;
    }
  | {
      type: "tool.completed";
      sessionId: string;
      toolName: string;
      result: string;
      executionTimeMs: number;
      isError: boolean;
      timestamp: string;
    }
  | {
      type: "file.changed";
      sessionId: string;
      filePath: string;
      action: "created" | "edited" | "deleted";
      operation?: string;
      timestamp: string;
    }
  | {
      type: "permission.requested";
      sessionId: string;
      toolName: string;
      target: string;
      action: "allow" | "ask" | "deny";
      timestamp: string;
    }
  | {
      type: "permission.resolved";
      sessionId: string;
      toolName: string;
      target: string;
      allowed: boolean;
      timestamp: string;
    }
  | {
      type: "hook.executed";
      sessionId: string;
      stage: string;
      hookName: string;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "context.compacted";
      sessionId: string;
      beforeTokens: number;
      afterTokens: number;
      timestamp: string;
    };

// Singleton Event Bus for all subsystems (TUI, Telemetry, VS Code, Web UI, Hooks)
class AgentEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Increase listener capacity for multiple subscribers
    this.emitter.setMaxListeners(50);
  }

  // Emit an event to all subscribers
  emit<T extends AgentEvent>(event: T): void {
    // Emit specific event type
    this.emitter.emit(event.type, event);
    // Emit wildcard event
    this.emitter.emit("*", event);
  }

  // Subscribe to a specific event type
  on<T extends AgentEvent>(
    type: T["type"],
    listener: (event: T) => void,
  ): () => void {
    this.emitter.on(type, listener as any);
    return () => this.emitter.off(type, listener as any);
  }

  // Subscribe to all events
  onAny(listener: (event: AgentEvent) => void): () => void {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }

  // Remove all listeners
  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}

// Global shared event bus instance
export const eventBus = new AgentEventBus();
