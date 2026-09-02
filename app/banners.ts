// ANSI color styling helpers
const c = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  boldBlue: (s: string) => `\x1b[1;34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  boldMagenta: (s: string) => `\x1b[1;35m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  boldRed: (s: string) => `\x1b[1;31m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  boldWhite: (s: string) => `\x1b[1;37m${s}\x1b[0m`,
};

// Render model-specific ASCII art banner
export function renderModelBanner(modelId: string): string {
  const m = modelId.toLowerCase();

  // 1. IBM Granite (Geometric Granite Rock / Crystal Hexagon)
  if (m.includes("granite")) {
    return [
      "",
      `    ${c.boldBlue("       /\\")} `,
      `    ${c.boldBlue("      /  \\")}        ${c.boldCyan("IBM GRANITE 4.2")} ${c.dim("· 3B")}`,
      `    ${c.boldCyan("     /\\   \\")}       ${c.gray("Hybrid Reasoning & Agentic Tool Engine")}`,
      `    ${c.boldCyan("    /  \\   \\")}      ${c.dim("Capabilities:")} ${c.yellow("Chain-of-Thought")} · ${c.cyan("Tools")} · ${c.green("RAG")}`,
      `    ${c.cyan("   /    \\___\\")}     ${c.dim("Context:")} ${c.boldWhite("131k tokens")} · ${c.dim("Status:")} ${c.boldGreen("● Active")}`,
      `    ${c.cyan("   \\    /   /")} `,
      `    ${c.blue("    \\  /   /")}  `,
      `    ${c.blue("     \\/___/")}   `,
      "",
    ].join("\n");
  }

  // 2. Qwen 2.5 Coder (Cyber Terminal / Isometric Code Block)
  if (m.includes("qwen2.5-coder") || (m.includes("coder") && !m.includes("3.5"))) {
    return [
      "",
      `    ${c.boldGreen("     ┌───────┐")}   `,
      `    ${c.boldGreen("    / █ █ █ /│")}    ${c.boldCyan("QWEN 2.5 CODER")} ${c.dim("· 7B Instruct")}`,
      `    ${c.green("   /───────/ │")}    ${c.gray("Deep Code Synthesis & Refactoring Engine")}`,
      `    ${c.green("   │ < / > │ │")}    ${c.dim("Capabilities:")} ${c.boldGreen("Code Search")} · ${c.cyan("Refactor")} · ${c.yellow("Debug")}`,
      `    ${c.boldCyan("   │  CODE │ /")}    ${c.dim("Context:")} ${c.boldWhite("64k tokens")} · ${c.dim("Status:")} ${c.boldGreen("● Active")}`,
      `    ${c.boldCyan("   └───────┘/")}   `,
      "",
    ].join("\n");
  }

  // 3. Gemma 3 Tools (Google DeepMind 4-Point Prism Star)
  if (m.includes("gemma")) {
    return [
      "",
      `    ${c.boldMagenta("        ▲")}        `,
      `    ${c.boldMagenta("      ◄ ◆ ►")}       ${c.boldYellow("GEMMA 3 TOOLS")} ${c.dim("· 4B")}`,
      `    ${c.magenta("        ▼")}         ${c.gray("Multimodal Vision & Function Calling Engine")}`,
      `    ${c.cyan("       / \\")}        ${c.dim("Capabilities:")} ${c.boldMagenta("Vision / Image")} · ${c.yellow("Function Calling")}`,
      `    ${c.cyan("      /   \\")}       ${c.dim("Context:")} ${c.boldWhite("64k tokens")} · ${c.dim("Status:")} ${c.boldGreen("● Active")}`,
      "",
    ].join("\n");
  }

  // 4. Mistral Ministral 3 (Iconic Layered Flame / Edge Core)
  if (m.includes("ministral") || m.includes("mistral")) {
    return [
      "",
      `    ${c.boldRed("     ▒▒▒▒▒▒▒▒")}   `,
      `    ${c.boldYellow("    ▒▒  ▒▒  ▒▒")}    ${c.boldRed("MINISTRAL 3")} ${c.dim("· 3B")}`,
      `    ${c.yellow("    ▒▒▒▒▒▒▒▒▒▒")}    ${c.gray("Low-Latency Structured Edge & Vision Engine")}`,
      `    ${c.boldRed("    ▒▒      ▒▒")}    ${c.dim("Capabilities:")} ${c.boldYellow("Vision")} · ${c.red("Fast JSON")} · ${c.cyan("Tools")}`,
      `    ${c.red("    ▒▒      ▒▒")}    ${c.dim("Context:")} ${c.boldWhite("64k tokens")} · ${c.dim("Status:")} ${c.boldGreen("● Active")}`,
      "",
    ].join("\n");
  }

  // 5. Liquid LFM 2.5 (Dynamic State-Space Liquid Waves)
  if (m.includes("lfm") || m.includes("liquid")) {
    return [
      "",
      `    ${c.boldCyan("     ╭───────╮")}   `,
      `    ${c.boldMagenta("    ╱  ~ ~ ~  ╲")}   ${c.boldCyan("LIQUID LFM 2.5")} ${c.dim("· 8B A1B")}`,
      `    ${c.magenta("   │  ≈ ≈ ≈ ≈  │")}  ${c.gray("Dynamical State-Space Neural Architecture")}`,
      `    ${c.boldCyan("    ╲  ~ ~ ~  ╱")}   ${c.dim("Capabilities:")} ${c.magenta("Low-Latency")} · ${c.cyan("Long Context")} · ${c.green("Tools")}`,
      `    ${c.cyan("     ╰───────╯")}    ${c.dim("Context:")} ${c.boldWhite("64k tokens")} · ${c.dim("Status:")} ${c.boldGreen("● Active")}`,
      "",
    ].join("\n");
  }

  // 6. Qwen 3.5 (Multimodal Vision & Thinking Reasoner)
  if (m.includes("qwen3.5") || m.includes("qwen-3.5")) {
    return [
      "",
      `    ${c.boldGreen("      ╭─━━━━─╮")}   `,
      `    ${c.boldCyan("     ╱  ◉  ◉  ╲")}   ${c.boldGreen("QWEN 3.5")} ${c.dim("· 4B")}`,
      `    ${c.cyan("    │    ▲     │")}  ${c.gray("Multimodal Vision & Deep Thinking Reasoner")}`,
      `    ${c.boldGreen("     ╲  ╰─╯   ╱")}   ${c.dim("Capabilities:")} ${c.boldCyan("Vision / OCR")} · ${c.yellow("Chain-of-Thought")} · ${c.green("Coding")}`,
      `    ${c.green("      ╰─━━━━─╯")}    ${c.dim("Context:")} ${c.boldWhite("64k tokens")} · ${c.dim("Status:")} ${c.boldGreen("● Active")}`,
      "",
    ].join("\n");
  }

  // Fallback generic banner
  return [
    "",
    `    ${c.boldCyan("  🤖 [Active Model]")} ${c.boldWhite(modelId)}`,
    `    ${c.gray("     Ready for autonomous coding, refactoring, and tool execution.")}`,
    "",
  ].join("\n");
}
