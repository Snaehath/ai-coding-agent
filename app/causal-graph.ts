import fs from "node:fs";
import path from "node:path";
import { getFullHardwareProfile } from "./environment.ts";

export type CausalLayer = "infrastructure" | "database" | "network" | "application" | "concurrency";
export type CausalNodeType = "root_cause" | "intermediate_effect" | "symptom" | "mitigation";

export interface CausalNode {
  id: string;
  label: string;
  layer: CausalLayer;
  type: CausalNodeType;
  evidence: string;
  confidence: number; // 0.0 - 1.0
}

export interface CausalEdge {
  from: string;
  to: string;
  relation: "triggers" | "amplifies" | "exhausts" | "blocks" | "degrades" | "cascades";
  mechanism: string;
}

export interface CausalAnalysisResult {
  symptom: string;
  rootCauses: CausalNode[];
  causalChain: Array<{ step: number; node: CausalNode; transition?: string }>;
  edges: CausalEdge[];
  mitigations: string[];
  asciiGraph: string;
}

// Causal Knowledge Patterns for Common Failure Cascades
const CAUSAL_PATTERNS: Array<{
  match: RegExp;
  chain: Array<{ label: string; layer: CausalLayer; type: CausalNodeType; mechanism: string }>;
  mitigations: string[];
}> = [
  {
    // High Latency / Slow DB -> Pool Saturation -> Timeouts -> Cascading Retry Storm
    match: /(slow|latency|timeout|econnrefused|pool\s*exhaust|too\s*many\s*connections|database\s*lock)/i,
    chain: [
      {
        label: "Database Query Latency or Missing Index",
        layer: "database",
        type: "root_cause",
        mechanism: "Heavy queries or lock contention hold connections longer than normal",
      },
      {
        label: "Connection Pool Saturation",
        layer: "database",
        type: "intermediate_effect",
        mechanism: "Active connections reach maximum pool capacity, queuing incoming requests",
      },
      {
        label: "HTTP Request Timeouts (504 / ECONNRESET)",
        layer: "application",
        type: "intermediate_effect",
        mechanism: "Queued requests exceed client/server timeout thresholds",
      },
      {
        label: "Aggressive Client Retries (Retry Storm)",
        layer: "network",
        type: "intermediate_effect",
        mechanism: "Timed-out clients immediately re-issue requests without exponential backoff or jitter",
      },
      {
        label: "Cascading Service Degradation / Total Lockup",
        layer: "infrastructure",
        type: "symptom",
        mechanism: "Exponential inbound request volume pushes server into memory/CPU saturation",
      },
    ],
    mitigations: [
      "Add missing database indexes and review slow query logs",
      "Configure exponential backoff with full jitter on all client/service retries",
      "Increase database pool ceiling or implement connection pool queue timeouts",
      "Deploy Circuit Breaker pattern (e.g. fail-fast when error rate > 50%)",
    ],
  },
  {
    // Out of Memory (OOM) / High RAM / VRAM Pressure
    match: /(oom|memory\s*leak|heap\s*out|out\s*of\s*memory|vram|cuda\s*oom|gc\s*thrash)/i,
    chain: [
      {
        label: "Unbounded In-Memory Accumulation / Model Context Bloat",
        layer: "application",
        type: "root_cause",
        mechanism: "Unbounded message history, cached buffers, or high model context length retained in memory",
      },
      {
        label: "Garbage Collection (GC) Thrashing & CPU Spikes",
        layer: "infrastructure",
        type: "intermediate_effect",
        mechanism: "V8/Runtime engine continuously pauses execution to free memory",
      },
      {
        label: "Event Loop Stalling / Request Queueing",
        layer: "application",
        type: "intermediate_effect",
        mechanism: "Main thread blocked by heavy GC or memory swapping",
      },
      {
        label: "Process Crash / CUDA Out-Of-Memory Termination",
        layer: "infrastructure",
        type: "symptom",
        mechanism: "OS/driver kills process due to exceeding memory limits",
      },
    ],
    mitigations: [
      "Enable intelligent history compaction (compressHistory / trimContextMessages)",
      "Switch to compact 3B/4B models (e.g. granite4.2:3b / gemma3-tools:4b) within 4GB VRAM limits",
      "Stream large file contents in chunks rather than reading entire files into RAM at once",
      "Inspect memory leaks using process.memoryUsage() / inspect('process')",
    ],
  },
  {
    // Repetitive Tool Calling Loop / Model Hallucination
    match: /(loop|infinite\s*loop|repeated\s*tool|hang|stuck|turn\s*limit)/i,
    chain: [
      {
        label: "Ambiguous User Prompt or Unhandled Tool Error",
        layer: "application",
        type: "root_cause",
        mechanism: "Model receives an error or non-conclusive output from a tool without clear recovery instructions",
      },
      {
        label: "Model Retries Identical Arguments",
        layer: "application",
        type: "intermediate_effect",
        mechanism: "Model fails to deduce alternative strategy and repeats the exact same tool call",
      },
      {
        label: "Context Window Rapid Consumption",
        layer: "application",
        type: "intermediate_effect",
        mechanism: "Repetitive failure turns accumulate in session history",
      },
      {
        label: "Turn Limit Exceeded / Agent Stall",
        layer: "application",
        type: "symptom",
        mechanism: "Agent hits MAX_TURNS limit without reaching a final user answer",
      },
    ],
    mitigations: [
      "Ensure ToolLoopDetector intercepts 3 consecutive identical tool calls",
      "Inject explicit error guidance in tool results explaining why it failed",
      "Provide progressive tool discovery (ToolSearch / Inspect) so model explores alternatives",
    ],
  },
  {
    // Permission Denials / Blocked Access
    match: /(permission|denied|unauthorized|blocked|policy|guardrail)/i,
    chain: [
      {
        label: "Restricted Filepath or Destructive Command Trigger",
        layer: "application",
        type: "root_cause",
        mechanism: "Operation targets protected resource (.ssh, system dir, rm -rf)",
      },
      {
        label: "Security Guardrail or Policy Interception",
        layer: "infrastructure",
        type: "intermediate_effect",
        mechanism: "evaluatePermission or validatePathSafety blocks execution",
      },
      {
        label: "Agent Blocked / Action Declined",
        layer: "application",
        type: "symptom",
        mechanism: "Tool returns permission error to prevent system damage",
      },
    ],
    mitigations: [
      "Review .agents/permissions.json rules for allowed operations",
      "Ensure command targets workspace-local files instead of system paths",
    ],
  },
];

// Perform Causal Failure & Root-Cause Analysis
export function analyzeCausalGraph(queryOrSymptom: string, contextSnippet?: string): CausalAnalysisResult {
  const query = queryOrSymptom.toLowerCase().trim();
  const hw = getFullHardwareProfile();

  // Find matching causal pattern or generate generic causal chain
  let pattern = CAUSAL_PATTERNS.find((p) => p.match.test(query));

  if (!pattern) {
    // Dynamic fallback chain based on general software failure causality
    pattern = {
      match: /.*/,
      chain: [
        {
          label: `Underlying Root Cause for "${queryOrSymptom.slice(0, 40)}"`,
          layer: "application",
          type: "root_cause",
          mechanism: "Initial anomaly or misconfiguration triggered the degradation",
        },
        {
          label: "Resource Contention or State Inconsistency",
          layer: "concurrency",
          type: "intermediate_effect",
          mechanism: "Propagates through dependent components",
        },
        {
          label: "Performance Degradation / Functional Error",
          layer: "application",
          type: "intermediate_effect",
          mechanism: "Error bubbles up to caller or surface layer",
        },
        {
          label: `Observable Symptom: ${queryOrSymptom}`,
          layer: "application",
          type: "symptom",
          mechanism: "Directly experienced failure state",
        },
      ],
      mitigations: [
        "Check recent error logs and telemetry for exact failure point",
        "Inspect system hardware and memory limits using inspect('hardware')",
        "Use ContextExtract / Grep to locate relevant error handler logic in code",
      ],
    };
  }

  // Construct nodes and edges
  const nodes: CausalNode[] = pattern.chain.map((c, idx) => ({
    id: `node_${idx + 1}`,
    label: c.label,
    layer: c.layer,
    type: c.type,
    evidence: idx === 0 && contextSnippet ? contextSnippet.slice(0, 100) : c.mechanism,
    confidence: idx === 0 ? 0.9 : 0.85,
  }));

  const edges: CausalEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      from: nodes[i].id,
      to: nodes[i + 1].id,
      relation: i === 0 ? "triggers" : i === nodes.length - 2 ? "cascades" : "amplifies",
      mechanism: pattern.chain[i].mechanism,
    });
  }

  const rootCauses = nodes.filter((n) => n.type === "root_cause");
  const causalChain = nodes.map((n, idx) => ({
    step: idx + 1,
    node: n,
    transition: edges[idx]?.mechanism,
  }));

  // Build visual ASCII Causal Flow Graph
  const asciiLines: string[] = ["  ┌── Causal Dependency Flow ──────────────────────────┐"];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const badge =
      node.type === "root_cause"
        ? "🔴 ROOT CAUSE"
        : node.type === "symptom"
          ? "💥 SYMPTOM"
          : "🟡 CASCADE";
    asciiLines.push(`  │ [${badge}] ${node.label} (${node.layer})`);
    if (i < nodes.length - 1) {
      asciiLines.push(`  │    │`);
      asciiLines.push(`  │    ▼ ${edges[i]?.relation.toUpperCase()}: ${edges[i]?.mechanism.slice(0, 50)}...`);
      asciiLines.push(`  │    │`);
    }
  }
  asciiLines.push("  └────────────────────────────────────────────────────────┘");

  return {
    symptom: queryOrSymptom,
    rootCauses,
    causalChain,
    edges,
    mitigations: pattern.mitigations,
    asciiGraph: asciiLines.join("\n"),
  };
}

// Format Causal Analysis as clean terminal markdown
export function executeCausalAnalyze(query: string, context?: string): string {
  try {
    const analysis = analyzeCausalGraph(query, context);

    const lines = [
      `🔬 Causal Graph Analysis for: "${analysis.symptom}"`,
      `\n${analysis.asciiGraph}\n`,
      `🧬 Step-by-Step Cause ➔ Effect Propagation:`,
      ...analysis.causalChain.map(
        (c) =>
          `  ${c.step}. [${c.node.layer.toUpperCase()}] ${c.node.label}\n     ↳ Mechanism: ${c.node.evidence}`,
      ),
      `\n💡 Recommended Remediation & Prevention:`,
      ...analysis.mitigations.map((m) => `  • ${m}`),
    ];

    return lines.join("\n");
  } catch (e: any) {
    return `Error performing causal analysis: ${e.message}`;
  }
}
