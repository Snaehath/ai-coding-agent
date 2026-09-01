// ANSI color styling
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
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  boldWhite: (s: string) => `\x1b[1;37m${s}\x1b[0m`,
};

// Render model-specific ASCII art banner
export function renderModelBanner(modelId: string): string {
  const m = modelId.toLowerCase();

  // 1. IBM Granite (Granite Rock / Crystal Hexagon)
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

  // Fallback generic banner
  return [
    "",
    `    ${c.boldCyan("  🤖 [Active Model]")} ${c.boldWhite(modelId)}`,
    `    ${c.gray("     Ready for coding, refactoring, and tool execution.")}`,
    "",
  ].join("\n");
}
