import { eventBus } from "./events.ts";

export type AgentState =
  | "IDLE"
  | "UNDERSTANDING"
  | "PLANNING"
  | "EXECUTING"
  | "VERIFYING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED";

export interface StateTransitionRecord {
  from: AgentState;
  to: AgentState;
  timestamp: string;
  durationMs: number;
  context?: Record<string, any>;
}

export type StateTransitionCallback = (
  from: AgentState,
  to: AgentState,
  context?: Record<string, any>,
) => void;

// Explicit State Machine defining allowed transitions
const ALLOWED_TRANSITIONS: Record<AgentState, AgentState[]> = {
  IDLE: ["UNDERSTANDING", "FAILED"],
  UNDERSTANDING: ["PLANNING", "EXECUTING", "WAITING", "FAILED"],
  PLANNING: ["EXECUTING", "VERIFYING", "WAITING", "COMPLETED", "FAILED"],
  EXECUTING: ["VERIFYING", "PLANNING", "WAITING", "COMPLETED", "FAILED"],
  VERIFYING: ["PLANNING", "EXECUTING", "COMPLETED", "FAILED"],
  WAITING: ["EXECUTING", "PLANNING", "COMPLETED", "FAILED"],
  COMPLETED: ["IDLE", "UNDERSTANDING"],
  FAILED: ["IDLE", "UNDERSTANDING"],
};

export class AgentStateMachine {
  private currentState: AgentState = "IDLE";
  private stateStartTime: number = performance.now();
  private history: StateTransitionRecord[] = [];
  private listeners: Set<StateTransitionCallback> = new Set();
  private enterListeners: Map<AgentState, Set<(ctx?: Record<string, any>) => void>> = new Map();
  private exitListeners: Map<AgentState, Set<(ctx?: Record<string, any>) => void>> = new Map();

  constructor() {
    this.stateStartTime = performance.now();
  }

  // Get active state
  get state(): AgentState {
    return this.currentState;
  }

  // Get full transition history
  get transitionHistory(): StateTransitionRecord[] {
    return [...this.history];
  }

  // Subscribe to all state transitions
  onTransition(callback: StateTransitionCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // Subscribe to entering a specific state
  onEnter(targetState: AgentState, callback: (ctx?: Record<string, any>) => void): () => void {
    if (!this.enterListeners.has(targetState)) {
      this.enterListeners.set(targetState, new Set());
    }
    this.enterListeners.get(targetState)!.add(callback);
    return () => this.enterListeners.get(targetState)?.delete(callback);
  }

  // Subscribe to exiting a specific state
  onExit(targetState: AgentState, callback: (ctx?: Record<string, any>) => void): () => void {
    if (!this.exitListeners.has(targetState)) {
      this.exitListeners.set(targetState, new Set());
    }
    this.exitListeners.get(targetState)!.add(callback);
    return () => this.exitListeners.get(targetState)?.delete(callback);
  }

  // Perform explicit state transition
  transitionTo(nextState: AgentState, context?: Record<string, any>): boolean {
    if (this.currentState === nextState) return true;

    const allowed = ALLOWED_TRANSITIONS[this.currentState];
    if (allowed && !allowed.includes(nextState)) {
      process.stderr.write(
        `[StateMachine] Warning: Invalid transition attempted: ${this.currentState} ➔ ${nextState}\n`,
      );
    }

    const from = this.currentState;
    const now = performance.now();
    const durationMs = Math.round(now - this.stateStartTime);

    // Trigger exit handlers
    const exitSet = this.exitListeners.get(from);
    if (exitSet) {
      for (const cb of exitSet) cb(context);
    }

    // Record history
    const record: StateTransitionRecord = {
      from,
      to: nextState,
      timestamp: new Date().toISOString(),
      durationMs,
      context,
    };
    this.history.push(record);

    // Update state
    this.currentState = nextState;
    this.stateStartTime = now;

    // Trigger global transition listeners
    for (const listener of this.listeners) {
      try {
        listener(from, nextState, context);
      } catch (e: any) {
        process.stderr.write(`[StateMachine] Listener error: ${e.message}\n`);
      }
    }

    // Trigger enter handlers
    const enterSet = this.enterListeners.get(nextState);
    if (enterSet) {
      for (const cb of enterSet) cb(context);
    }

    // Emit event on global AgentEventBus
    eventBus.emit({
      type: "state.changed" as any,
      sessionId: context?.sessionId || "global",
      from,
      to: nextState,
      durationMs,
      context,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  // Reset state machine to IDLE
  reset() {
    this.currentState = "IDLE";
    this.stateStartTime = performance.now();
    this.history = [];
  }

  // Render visual State Machine timeline report
  renderStateReport(): string {
    const lines = [
      `🔄 Agent Lifecycle State Machine:`,
      `  • Current State            : ${this.getStateBadge(this.currentState)}`,
      `  • Dwell in Current State   : ${((performance.now() - this.stateStartTime) / 1000).toFixed(1)}s`,
      `  • Total Transitions Logged : ${this.history.length}`,
    ];

    if (this.history.length > 0) {
      lines.push(`\n📈 Lifecycle State Timeline:`);
      for (let i = 0; i < this.history.length; i++) {
        const h = this.history[i];
        const detail = h.context?.action ? ` (${h.context.action})` : "";
        lines.push(
          `  ${i + 1}. ${h.from} ➔ ${this.getStateBadge(h.to)} [${h.durationMs}ms]${detail}`,
        );
      }
    }

    return lines.join("\n");
  }

  private getStateBadge(state: AgentState): string {
    switch (state) {
      case "IDLE":
        return "⚪ IDLE";
      case "UNDERSTANDING":
        return "🧠 UNDERSTANDING";
      case "PLANNING":
        return "📝 PLANNING";
      case "EXECUTING":
        return "⚡ EXECUTING";
      case "VERIFYING":
        return "🔍 VERIFYING";
      case "WAITING":
        return "⏳ WAITING";
      case "COMPLETED":
        return "✅ COMPLETED";
      case "FAILED":
        return "❌ FAILED";
      default:
        return state;
    }
  }
}

// Global Singleton State Machine
export const stateMachine = new AgentStateMachine();
