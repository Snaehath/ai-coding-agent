// ANSI escape codes
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  boldCyan: "\x1b[1;36m",
  yellow: "\x1b[33m",
  boldYellow: "\x1b[1;33m",
  green: "\x1b[32m",
  boldGreen: "\x1b[1;32m",
  magenta: "\x1b[35m",
  boldMagenta: "\x1b[1;35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
  boldWhite: "\x1b[1;37m",
  bgDark: "\x1b[48;5;236m",
};

// Syntax keywords for basic code block highlighting
const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "import", "export", "from",
  "if", "else", "for", "while", "switch", "case", "break", "continue",
  "class", "extends", "implements", "interface", "type", "async", "await",
  "try", "catch", "finally", "throw", "new", "this", "typeof", "instanceof",
  "def", "class", "self", "None", "True", "False", "print", "lambda",
  "fn", "pub", "struct", "enum", "impl", "mut", "match", "use",
]);

function highlightCodeLine(line: string): string {
  // Comments
  if (/^\s*(\/\/|#)/.test(line)) {
    return `${ANSI.gray}${line}${ANSI.reset}`;
  }

  // Highlight strings in green
  let highlighted = line.replace(/(["'`])(?:(?=(\\?))\2[\s\S])*?\1/g, (m) => `${ANSI.green}${m}${ANSI.reset}`);

  // Highlight keywords
  highlighted = highlighted.replace(/\b([a-zA-Z_]\w*)\b/g, (match) => {
    if (KEYWORDS.has(match)) {
      return `${ANSI.boldMagenta}${match}${ANSI.reset}`;
    }
    if (/^[A-Z][a-zA-Z0-9_]*$/.test(match)) {
      return `${ANSI.cyan}${match}${ANSI.reset}`; // Types / Classes
    }
    return match;
  });

  return highlighted;
}

// Render markdown text into styled terminal ANSI output
export function renderTerminalMarkdown(md: string): string {
  if (!md) return "";

  const lines = md.split(/\r?\n/);
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Code block start / end
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        // Close code block
        inCodeBlock = false;
        formatted.push(`  ${ANSI.gray}└${"─".repeat(56)}┘${ANSI.reset}`);
        codeBuffer = [];
      } else {
        // Open code block
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim() || "code";
        formatted.push(`  ${ANSI.gray}┌── ${ANSI.boldCyan(codeLang)} ${"─".repeat(Math.max(2, 50 - codeLang.length))}┐${ANSI.reset}`);
      }
      continue;
    }

    if (inCodeBlock) {
      formatted.push(`  ${ANSI.gray}│${ANSI.reset} ${highlightCodeLine(rawLine)}`);
      continue;
    }

    // Headers (# H1, ## H2, ### H3)
    if (/^#\s+/.test(rawLine)) {
      const text = rawLine.replace(/^#\s+/, "");
      formatted.push(`\n${ANSI.boldCyan(formatInlineMarkdown(text))}\n${ANSI.cyan("━".repeat(Math.min(60, text.length + 2)))}${ANSI.reset}`);
      continue;
    }
    if (/^##\s+/.test(rawLine)) {
      const text = rawLine.replace(/^##\s+/, "");
      formatted.push(`\n${ANSI.boldYellow(formatInlineMarkdown(text))}`);
      continue;
    }
    if (/^###\s+/.test(rawLine)) {
      const text = rawLine.replace(/^###\s+/, "");
      formatted.push(`\n${ANSI.boldWhite(formatInlineMarkdown(text))}`);
      continue;
    }

    // Horizontal rule (--- or ***)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      formatted.push(`${ANSI.gray}${"─".repeat(60)}${ANSI.reset}`);
      continue;
    }

    // Blockquote (> text)
    if (/^>\s*/.test(rawLine)) {
      const quote = rawLine.replace(/^>\s*/, "");
      formatted.push(`  ${ANSI.cyan}│${ANSI.reset} ${ANSI.italic}${formatInlineMarkdown(quote)}${ANSI.reset}`);
      continue;
    }

    // Bullet list (* item or - item or + item)
    if (/^(\s*)[*+-]\s+(.+)/.test(rawLine)) {
      const match = rawLine.match(/^(\s*)[*+-]\s+(.+)/);
      if (match) {
        const indent = match[1];
        const content = match[2];
        formatted.push(`${indent}  ${ANSI.cyan}•${ANSI.reset} ${formatInlineMarkdown(content)}`);
        continue;
      }
    }

    // Numbered list (1. item)
    if (/^(\s*)(\d+)\.\s+(.+)/.test(rawLine)) {
      const match = rawLine.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (match) {
        const indent = match[1];
        const num = match[2];
        const content = match[3];
        formatted.push(`${indent}  ${ANSI.boldYellow(`${num}.`)}${ANSI.reset} ${formatInlineMarkdown(content)}`);
        continue;
      }
    }

    // Table divider line (|---|---|)
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      formatted.push(`${ANSI.gray}${trimmed.replace(/:/g, "─").replace(/-/g, "─").replace(/\|/g, "┼")}${ANSI.reset}`);
      continue;
    }

    // Table row (| col1 | col2 |)
    if (/^\|(.+)\|$/.test(trimmed)) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => formatInlineMarkdown(c.trim()));
      formatted.push(`  ${ANSI.gray}│${ANSI.reset} ${cells.join(` ${ANSI.gray}│${ANSI.reset} `)} ${ANSI.gray}│${ANSI.reset}`);
      continue;
    }

    // Standard paragraph line
    formatted.push(formatInlineMarkdown(rawLine));
  }

  return formatted.join("\n");
}

// Format inline markdown (**bold**, *italic*, `code`, ~~strikethrough~~)
export function formatInlineMarkdown(text: string): string {
  let res = text;

  // Bold & Italic combined (***text*** or ___text___)
  res = res.replace(/(\*\*\*|___)(.*?)\1/g, `${ANSI.bold}${ANSI.italic}$2${ANSI.reset}`);

  // Bold (**text** or __text__)
  res = res.replace(/(\*\*|__)(.*?)\1/g, `${ANSI.bold}$2${ANSI.reset}`);

  // Inline code (`text`)
  res = res.replace(/`([^`]+)`/g, `${ANSI.boldYellow}$1${ANSI.reset}`);

  // Italic (*text* or _text_)
  res = res.replace(/(\*|_)(.*?)\1/g, `${ANSI.italic}$2${ANSI.reset}`);

  // Strikethrough (~~text~~)
  res = res.replace(/~~(.*?)~~/g, `\x1b[9m$1${ANSI.reset}`);

  return res;
}

// Line-buffered streaming Markdown renderer for real-time styled terminal output
export function createMarkdownStreamer(writer: (text: string) => void) {
  let lineBuffer = "";
  let inCodeBlock = false;

  return {
    write(token: string) {
      lineBuffer += token;
      if (lineBuffer.includes("\n")) {
        const parts = lineBuffer.split("\n");
        lineBuffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (trimmed.startsWith("```")) {
            if (inCodeBlock) {
              inCodeBlock = false;
              writer(`  ${ANSI.gray}└${"─".repeat(56)}┘${ANSI.reset}\n`);
            } else {
              inCodeBlock = true;
              const lang = trimmed.slice(3).trim() || "code";
              writer(`  ${ANSI.gray}┌── ${ANSI.boldCyan(lang)} ${"─".repeat(Math.max(2, 50 - lang.length))}┐${ANSI.reset}\n`);
            }
            continue;
          }

          if (inCodeBlock) {
            writer(`  ${ANSI.gray}│${ANSI.reset} ${highlightCodeLine(line)}\n`);
            continue;
          }

          writer(renderTerminalMarkdown(line) + "\n");
        }
      }
    },
    flush() {
      if (lineBuffer.length > 0) {
        writer(renderTerminalMarkdown(lineBuffer));
        lineBuffer = "";
      }
    },
  };
}
