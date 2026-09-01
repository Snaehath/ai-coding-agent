// Terminal Markdown & ANSI Highlighter

// Color helpers
const c = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  boldMagenta: (s: string) => `\x1b[1;35m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
  bgDark: (s: string) => `\x1b[48;5;236m${s}\x1b[0m`,
  codeBg: (s: string) => `\x1b[48;5;235m\x1b[36m ${s} \x1b[0m`,
};

// Syntax highlight tokens inside code blocks
function highlightCode(code: string, lang: string = ""): string {
  const keywords = new Set([
    "import", "from", "export", "const", "let", "var", "function", "return",
    "if", "else", "for", "while", "class", "async", "await", "try", "catch",
    "finally", "switch", "case", "default", "break", "continue", "new", "type",
    "interface", "extends", "implements", "public", "private", "protected",
    "def", "self", "elif", "print", "None", "True", "False", "fn", "mut",
    "pub", "impl", "struct", "enum", "match", "use", "mod", "package", "go",
  ]);

  return code
    .split("\n")
    .map((line) => {
      // Comments
      if (/^\s*(\/\/|#|\/\*|\*)/.test(line)) {
        return c.dim(c.italic(line));
      }

      // Strings ("..." or '...' or `...`)
      line = line.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, (m) => c.green(m));

      // Numbers
      line = line.replace(/\b(\d+(\.\d+)?)\b/g, (m) => c.yellow(m));

      // Keywords
      line = line.replace(/\b([a-zA-Z_]\w*)\b/g, (word) => {
        if (keywords.has(word)) return c.boldMagenta(word);
        return word;
      });

      return line;
    })
    .join("\n");
}

// Render complete markdown document to styled terminal ANSI text
export function renderTerminalMarkdown(markdown: string): string {
  if (!markdown) return "";

  const lines = markdown.split("\n");
  const rendered: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Code block toggle (```)
    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim() || "code";
        codeBuffer = [];
        rendered.push(
          `  ${c.gray("╭─")} ${c.boldYellow(codeLang)} ${c.gray("─".repeat(Math.max(10, 48 - codeLang.length)))}`,
        );
      } else {
        inCodeBlock = false;
        const highlighted = highlightCode(codeBuffer.join("\n"), codeLang);
        const codeLines = highlighted.split("\n");
        for (const cl of codeLines) {
          rendered.push(`  ${c.gray("│")}  ${cl}`);
        }
        rendered.push(`  ${c.gray("╰" + "─".repeat(52))}`);
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    // Horizontal rules (--- or ***)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      rendered.push(c.gray("  " + "─".repeat(50)));
      continue;
    }

    // Headings
    if (/^#\s+/.test(trimmed)) {
      const headingText = formatInlineStyles(trimmed.replace(/^#\s+/, ""));
      rendered.push(`\n${c.boldCyan(c.underline(headingText))}\n`);
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      const headingText = formatInlineStyles(trimmed.replace(/^##\s+/, ""));
      rendered.push(`\n${c.boldYellow(headingText)}`);
      continue;
    }
    if (/^###\s+/.test(trimmed)) {
      const headingText = formatInlineStyles(trimmed.replace(/^###\s+/, ""));
      rendered.push(`\n${c.bold(c.cyan(headingText))}`);
      continue;
    }

    // Blockquotes (> text)
    if (/^>\s*/.test(trimmed)) {
      const quoteText = formatInlineStyles(trimmed.replace(/^>\s*/, ""));
      rendered.push(`  ${c.yellow("│")} ${c.dim(c.italic(quoteText))}`);
      continue;
    }

    // Bullet points (* text or - text)
    if (/^(\*|-)\s+/.test(trimmed)) {
      const itemText = formatInlineStyles(trimmed.replace(/^(\*|-)\s+/, ""));
      rendered.push(`  ${c.cyan("•")} ${itemText}`);
      continue;
    }

    // Numbered lists (1. text)
    if (/^(\d+)\.\s+/.test(trimmed)) {
      const match = trimmed.match(/^(\d+)\.\s+(.*)$/);
      if (match) {
        const num = match[1];
        const itemText = formatInlineStyles(match[2]);
        rendered.push(`  ${c.yellow(num + ".")} ${itemText}`);
        continue;
      }
    }

    // Table rows (| col 1 | col 2 |)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      // Skip table separator line (|---|---|)
      if (/^\|(\s*:?-+:?\s*\|)+$/.test(trimmed)) {
        continue;
      }
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => formatInlineStyles(cell.trim()));
      rendered.push(`  ${c.gray("│")} ${cells.join(c.gray(" │ "))} ${c.gray("│")}`);
      continue;
    }

    // Standard paragraph with inline formatting
    rendered.push(formatInlineStyles(rawLine));
  }

  // Close unclosed code block if any
  if (inCodeBlock && codeBuffer.length > 0) {
    const highlighted = highlightCode(codeBuffer.join("\n"), codeLang);
    for (const cl of highlighted.split("\n")) {
      rendered.push(`  ${c.gray("│")}  ${cl}`);
    }
    rendered.push(`  ${c.gray("╰" + "─".repeat(52))}`);
  }

  return rendered.join("\n");
}

// Inline formatting (bold, italic, inline code, links)
export function formatInlineStyles(text: string): string {
  if (!text) return "";

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, (_m, code) => c.cyan(`\x1b[1m${code}\x1b[0m`));

  // Bold & Italic: ***text*** or ___text___
  text = text.replace(/(\*\*\*|___)(.*?)\1/g, (_m, _s, content) =>
    c.bold(c.italic(content)),
  );

  // Bold: **text** or __text__
  text = text.replace(/(\*\*|__)(.*?)\1/g, (_m, _s, content) => {
    // Check if it's a bold header like **The Wolf:**
    if (content.endsWith(":")) {
      return c.boldCyan(content);
    }
    return c.bold(content);
  });

  // Italic: *text* or _text_ (when not part of a bullet or word)
  text = text.replace(/(^|\s)(\*|_)([^\*_]+?)\2(?=\s|$|[.,;:!?])/g, (_m, prefix, _s, content) =>
    `${prefix}${c.italic(content)}`,
  );

  return text;
}

// Streaming Markdown Token Buffer
// Formats live tokens in real time with instant ANSI styling and zero lag
export class StreamingMarkdownFormatter {
  private inCodeBlock = false;
  private isBold = false;
  private isItalic = false;
  private atLineStart = true;
  private codeLangBuffer = "";

  public feed(chunk: string): string {
    if (!chunk) return "";

    let output = "";
    let i = 0;

    while (i < chunk.length) {
      // Check for code fences (```)
      if (chunk.slice(i).startsWith("```")) {
        i += 3;
        if (!this.inCodeBlock) {
          this.inCodeBlock = true;
          // Look ahead for language
          const rest = chunk.slice(i);
          const nlIdx = rest.indexOf("\n");
          const lang = nlIdx !== -1 ? rest.slice(0, nlIdx).trim() : rest.trim();
          i += lang.length;
          const displayLang = lang || "code";
          output += `\n  ${c.gray("╭─")} ${c.boldYellow(displayLang)} ${c.gray("─".repeat(Math.max(8, 42 - displayLang.length)))}\n`;
        } else {
          this.inCodeBlock = false;
          output += `  ${c.gray("╰" + "─".repeat(46))}\n`;
        }
        continue;
      }

      const ch = chunk[i];

      // Code block content styling
      if (this.inCodeBlock) {
        if (ch === "\n") {
          output += `\n  ${c.gray("│")}  `;
          this.atLineStart = false;
        } else {
          output += ch;
        }
        i++;
        continue;
      }

      // Check for bold (**)
      if (chunk.slice(i, i + 2) === "**") {
        i += 2;
        this.isBold = !this.isBold;
        output += this.isBold ? "\x1b[1m\x1b[36m" : "\x1b[0m";
        continue;
      }

      // Check for inline code (`)
      if (ch === "`" && chunk.slice(i, i + 3) !== "```") {
        i++;
        output += c.cyan(ch);
        continue;
      }

      // Newline handling
      if (ch === "\n") {
        this.atLineStart = true;
        output += "\n";
        i++;
        continue;
      }

      // Line start decorations (bullets, headings, quotes)
      if (this.atLineStart) {
        // Bullet points (* or -)
        if (
          (ch === "*" || ch === "-") &&
          (chunk[i + 1] === " " || chunk[i + 1] === "\t")
        ) {
          output += `  ${c.cyan("•")} `;
          i += 2;
          this.atLineStart = false;
          continue;
        }

        // Headings (### or ## or #)
        if (ch === "#") {
          let hashes = 0;
          while (chunk[i + hashes] === "#") hashes++;
          if (chunk[i + hashes] === " ") {
            i += hashes + 1;
            this.atLineStart = false;
            output +=
              hashes === 1
                ? c.boldCyan("\n# ")
                : hashes === 2
                  ? c.boldYellow("\n## ")
                  : c.bold("\n### ");
            continue;
          }
        }

        // Blockquotes (>)
        if (ch === ">" && chunk[i + 1] === " ") {
          output += `  ${c.yellow("│")} ${c.dim("")}`;
          i += 2;
          this.atLineStart = false;
          continue;
        }

        if (ch !== " " && ch !== "\t") {
          this.atLineStart = false;
        }
      }

      output += ch;
      i++;
    }

    return output;
  }

  public flush(): string {
    // Reset styling
    if (this.isBold || this.isItalic) {
      return "\x1b[0m";
    }
    return "";
  }
}
