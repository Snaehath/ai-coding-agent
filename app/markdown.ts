// ANSI formatting helpers
export const ANSI = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  boldMagenta: (s: string) => `\x1b[1;35m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  boldWhite: (s: string) => `\x1b[1;37m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
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
    return ANSI.gray(line);
  }

  // Highlight strings in green
  let highlighted = line.replace(
    /(["'`])(?:(?=(\\?))\2[\s\S])*?\1/g,
    (m) => ANSI.green(m),
  );

  // Highlight keywords
  highlighted = highlighted.replace(/\b([a-zA-Z_]\w*)\b/g, (match) => {
    if (KEYWORDS.has(match)) {
      return ANSI.boldMagenta(match);
    }
    if (/^[A-Z][a-zA-Z0-9_]*$/.test(match)) {
      return ANSI.cyan(match);
    }
    return match;
  });

  return highlighted;
}

// Format inline markdown (**bold**, *italic*, `code`, ~~strikethrough~~)
export function formatInlineMarkdown(text: string): string {
  if (!text) return "";
  let res = text;

  // Bold & Italic combined (***text*** or ___text___)
  res = res.replace(/(\*\*\*|___)(.*?)\1/g, (_, __, inner) =>
    ANSI.bold(ANSI.italic(inner)),
  );

  // Bold (**text** or __text__)
  res = res.replace(/(\*\*|__)(.*?)\1/g, (_, __, inner) =>
    ANSI.bold(inner),
  );

  // Inline code (`text`)
  res = res.replace(/`([^`]+)`/g, (_, inner) => ANSI.boldYellow(inner));

  // Italic (*text* or _text_)
  res = res.replace(/(\*|_)(.*?)\1/g, (_, __, inner) => ANSI.italic(inner));

  // Strikethrough (~~text~~)
  res = res.replace(/~~(.*?)~~/g, (_, inner) => `\x1b[9m${inner}\x1b[0m`);

  return res;
}

// Render markdown text into styled terminal ANSI output
export function renderTerminalMarkdown(md: string): string {
  if (!md) return "";

  const lines = md.split(/\r?\n/);
  const formatted: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Code block start / end
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        formatted.push(`  ${ANSI.gray(`└${"─".repeat(56)}┘`)}`);
      } else {
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim() || "code";
        formatted.push(
          `  ${ANSI.gray(`┌── `)}${ANSI.boldCyan(codeLang)}${ANSI.gray(` ${"─".repeat(Math.max(2, 50 - codeLang.length))}┐`)}`,
        );
      }
      continue;
    }

    if (inCodeBlock) {
      formatted.push(`  ${ANSI.gray("│")} ${highlightCodeLine(rawLine)}`);
      continue;
    }

    // Headers (# H1, ## H2, ### H3)
    if (/^#\s+/.test(rawLine)) {
      const text = rawLine.replace(/^#\s+/, "");
      formatted.push(
        `\n${ANSI.boldCyan(formatInlineMarkdown(text))}\n${ANSI.cyan("━".repeat(Math.min(60, text.length + 2)))}`,
      );
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
      formatted.push(ANSI.gray("─".repeat(60)));
      continue;
    }

    // Blockquote (> text)
    if (/^>\s*/.test(rawLine)) {
      const quote = rawLine.replace(/^>\s*/, "");
      formatted.push(`  ${ANSI.cyan("│")} ${ANSI.italic(formatInlineMarkdown(quote))}`);
      continue;
    }

    // Bullet list (* item or - item or + item)
    if (/^(\s*)[*+-]\s+(.+)/.test(rawLine)) {
      const match = rawLine.match(/^(\s*)[*+-]\s+(.+)/);
      if (match) {
        const indent = match[1];
        const content = match[2];
        formatted.push(
          `${indent}  ${ANSI.cyan("•")} ${formatInlineMarkdown(content)}`,
        );
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
        formatted.push(
          `${indent}  ${ANSI.boldYellow(`${num}.`)} ${formatInlineMarkdown(content)}`,
        );
        continue;
      }
    }

    // Table divider line (|---|---|)
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      formatted.push(
        ANSI.gray(
          trimmed.replace(/:/g, "─").replace(/-/g, "─").replace(/\|/g, "┼"),
        ),
      );
      continue;
    }

    // Table row (| col1 | col2 |)
    if (/^\|(.+)\|$/.test(trimmed)) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => formatInlineMarkdown(c.trim()));
      formatted.push(
        `  ${ANSI.gray("│")} ${cells.join(` ${ANSI.gray("│")} `)} ${ANSI.gray("│")}`,
      );
      continue;
    }

    // Standard paragraph line
    formatted.push(formatInlineMarkdown(rawLine));
  }

  return formatted.join("\n");
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
              writer(`  ${ANSI.gray(`└${"─".repeat(56)}┘`)}\n`);
            } else {
              inCodeBlock = true;
              const lang = trimmed.slice(3).trim() || "code";
              writer(
                `  ${ANSI.gray(`┌── `)}${ANSI.boldCyan(lang)}${ANSI.gray(` ${"─".repeat(Math.max(2, 50 - lang.length))}┐`)}\n`,
              );
            }
            continue;
          }

          if (inCodeBlock) {
            writer(`  ${ANSI.gray("│")} ${highlightCodeLine(line)}\n`);
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
