import fs from "node:fs";
import path from "node:path";

export interface EvaluationCriterion {
  name: string;
  category: "code" | "security" | "task" | "style" | "test";
  score: number; // 0 to 100
  weight: number; // e.g. 0.25
  passed: boolean;
  feedback: string[];
}

export interface EvaluationResult {
  overallScore: number; // 0 to 100
  passed: boolean;
  verdict: "ACCEPT" | "RETRY" | "NEEDS_IMPROVEMENT";
  criteria: EvaluationCriterion[];
  summary: string;
  retryPrompt?: string;
  timestamp: string;
}

export interface EvaluatorContext {
  prompt: string;
  output: string;
  actionLog?: string[];
  filesModified?: string[];
  messages?: any[];
}

export interface AgentEvaluator {
  name: string;
  category: "code" | "security" | "task" | "style" | "test";
  weight: number;
  evaluate(ctx: EvaluatorContext): Promise<EvaluationCriterion> | EvaluationCriterion;
}

// 1. Code Quality & Syntax Evaluator
export const codeEvaluator: AgentEvaluator = {
  name: "CodeEvaluator",
  category: "code",
  weight: 0.25,
  evaluate: (ctx) => {
    const feedback: string[] = [];
    let score = 100;

    // Check for raw unhandled JSON artifact leaks
    if (/```json\s*\{[\s\S]*?"name":\s*"(?:Read|Write|Edit|Bash)"/i.test(ctx.output)) {
      score -= 30;
      feedback.push("Contains raw unexecuted JSON tool call artifacts in final response.");
    }

    // Check for unclosed code fences
    const codeBlocks = (ctx.output.match(/```/g) || []).length;
    if (codeBlocks % 2 !== 0) {
      score -= 20;
      feedback.push("Unclosed markdown code fence detected.");
    }

    // Check for empty or trivial response
    if (ctx.output.trim().length < 15 && (!ctx.actionLog || ctx.actionLog.length === 0)) {
      score -= 50;
      feedback.push("Response is too brief or lacks substantive content.");
    }

    if (feedback.length === 0) {
      feedback.push("Clean code structure and proper formatting.");
    }

    return {
      name: "Code Quality & Syntax",
      category: "code",
      score: Math.max(0, score),
      weight: 0.25,
      passed: score >= 70,
      feedback,
    };
  },
};

// 2. Security & Guardrail Evaluator
export const securityEvaluator: AgentEvaluator = {
  name: "SecurityEvaluator",
  category: "security",
  weight: 0.25,
  evaluate: (ctx) => {
    const feedback: string[] = [];
    let score = 100;

    // Check for exposed tokens / keys
    if (/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/.test(ctx.output)) {
      score -= 60;
      feedback.push("Detected exposed GitHub token pattern.");
    }
    if (/sk-[A-Za-z0-9]{32,}/.test(ctx.output)) {
      score -= 60;
      feedback.push("Detected exposed OpenAI API key pattern.");
    }

    // Check for dangerous shell patterns in output suggestions
    if (/rm\s+-rf\s+[\/\\]|del\s+\/s\s+\/q\s+[A-Za-z]:\\/i.test(ctx.output)) {
      score -= 40;
      feedback.push("Dangerous recursive deletion command suggested.");
    }

    if (feedback.length === 0) {
      feedback.push("Zero credential exposure or destructive patterns detected.");
    }

    return {
      name: "Security & Credential Safety",
      category: "security",
      score: Math.max(0, score),
      weight: 0.25,
      passed: score >= 80,
      feedback,
    };
  },
};

// 3. Task Completion & Intent Alignment Evaluator
export const taskEvaluator: AgentEvaluator = {
  name: "TaskEvaluator",
  category: "task",
  weight: 0.3,
  evaluate: (ctx) => {
    const feedback: string[] = [];
    let score = 100;
    const promptLower = ctx.prompt.toLowerCase();

    // Check if user requested a specific file operation
    if (
      (promptLower.includes("read") || promptLower.includes("view") || promptLower.includes("check")) &&
      ctx.actionLog &&
      ctx.actionLog.length === 0 &&
      !ctx.output.toLowerCase().includes("file")
    ) {
      score -= 25;
      feedback.push("User prompt requested file inspection, but no file actions were logged.");
    }

    // Check if user asked for a bulleted list or specific count
    const countMatch = promptLower.match(/(\d+)\s+(?:bullet|points|items|reasons|examples)/);
    if (countMatch) {
      const expectedCount = parseInt(countMatch[1], 10);
      const bullets = (ctx.output.match(/^[\s]*[•\-\*\d+\.]\s+/gm) || []).length;
      if (bullets < expectedCount) {
        score -= 20;
        feedback.push(`Requested ${expectedCount} items/bullets, but only ${bullets} were identified.`);
      }
    }

    if (feedback.length === 0) {
      feedback.push("Output directly addresses user prompt requirements.");
    }

    return {
      name: "Task Completion & Intent Alignment",
      category: "task",
      score: Math.max(0, score),
      weight: 0.3,
      passed: score >= 70,
      feedback,
    };
  },
};

// 4. Style & Clarity Evaluator
export const styleEvaluator: AgentEvaluator = {
  name: "StyleEvaluator",
  category: "style",
  weight: 0.2,
  evaluate: (ctx) => {
    const feedback: string[] = [];
    let score = 100;

    // Check for thinking tag leaks
    if (/<think>|<\/think>/i.test(ctx.output)) {
      score -= 30;
      feedback.push("Contains unstripped <think> tags in final response.");
    }

    // Check for repetitive phrases
    if (/I will now|Let me now|Now I am going to/gi.test(ctx.output)) {
      score -= 10;
      feedback.push("Contains conversational filler phrases.");
    }

    if (feedback.length === 0) {
      feedback.push("Concise, professional, and clear formatting.");
    }

    return {
      name: "Style & Clarity",
      category: "style",
      score: Math.max(0, score),
      weight: 0.2,
      passed: score >= 75,
      feedback,
    };
  },
};

// Master Evaluator Pipeline
export class EvaluatorEngine {
  private evaluators: AgentEvaluator[] = [
    codeEvaluator,
    securityEvaluator,
    taskEvaluator,
    styleEvaluator,
  ];

  // Register custom evaluator
  register(evaluator: AgentEvaluator) {
    this.evaluators.push(evaluator);
  }

  // Run full evaluation suite
  async evaluate(ctx: EvaluatorContext, threshold = 70): Promise<EvaluationResult> {
    const criteria: EvaluationCriterion[] = [];
    let weightedSum = 0;
    let totalWeight = 0;

    for (const ev of this.evaluators) {
      try {
        const res = await ev.evaluate(ctx);
        criteria.push(res);
        weightedSum += res.score * res.weight;
        totalWeight += res.weight;
      } catch (e: any) {
        process.stderr.write(`[Evaluator] Warning: ${ev.name} error: ${e.message}\n`);
      }
    }

    const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 100;
    const passed = overallScore >= threshold;
    const verdict = overallScore >= 85 ? "ACCEPT" : overallScore >= threshold ? "NEEDS_IMPROVEMENT" : "RETRY";

    // Build targeted retry prompt if score is sub-optimal
    let retryPrompt: string | undefined;
    if (!passed || verdict === "RETRY") {
      const issues: string[] = [];
      for (const c of criteria) {
        if (!c.passed) {
          issues.push(...c.feedback.map((f) => `• [${c.name}]: ${f}`));
        }
      }
      retryPrompt = `[Evaluator Critique - Score: ${overallScore}/100]:\nThe previous response did not meet quality standards (${verdict}). Please fix the following issues and provide an improved response:\n${issues.join("\n")}`;
    }

    const summary = `Evaluator Score: ${overallScore}/100 (${verdict}) — ${criteria.filter((c) => c.passed).length}/${criteria.length} criteria passed.`;

    return {
      overallScore,
      passed,
      verdict,
      criteria,
      summary,
      retryPrompt,
      timestamp: new Date().toISOString(),
    };
  }

  // Render visual evaluation box
  formatEvaluationReport(result: EvaluationResult): string {
    const badge =
      result.verdict === "ACCEPT"
        ? `\x1b[1;32m[🟢 ACCEPT - ${result.overallScore}/100]\x1b[0m`
        : result.verdict === "NEEDS_IMPROVEMENT"
          ? `\x1b[1;33m[🟡 NEEDS IMPROVEMENT - ${result.overallScore}/100]\x1b[0m`
          : `\x1b[1;31m[🔴 RETRY - ${result.overallScore}/100]\x1b[0m`;

    const lines = [
      `🧠 Evaluator Judgment & Self-Critique:`,
      `  • Overall Verdict : ${badge}`,
      `  • Timestamp       : \x1b[90m${result.timestamp}\x1b[0m\n`,
      `📊 Evaluator Breakdown:`,
    ];

    for (const c of result.criteria) {
      const icon = c.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      const scoreColor = c.score >= 80 ? "\x1b[32m" : c.score >= 60 ? "\x1b[33m" : "\x1b[31m";
      lines.push(
        `  ${icon} \x1b[1m${c.name}\x1b[0m [weight: ${c.weight}] ➔ ${scoreColor}${c.score}/100\x1b[0m`,
      );
      for (const fb of c.feedback) {
        lines.push(`    \x1b[90m↳ ${fb}\x1b[0m`);
      }
    }

    if (result.retryPrompt) {
      lines.push(`\n🔄 \x1b[1;33mSelf-Improvement Guidance:\x1b[0m`);
      lines.push(`  \x1b[90m${result.retryPrompt.replace(/\n/g, "\n  ")}\x1b[0m`);
    }

    return lines.join("\n");
  }
}

// Global Singleton Evaluator
export const evaluatorEngine = new EvaluatorEngine();
