import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

/**
 * Normalizes file paths so that leading slashes (/app/main.ts)
 * or relative paths correctly resolve within the workspace.
 */
function resolveFilePath(filePath: string): string {
  if (!filePath) return "";
  if (fs.existsSync(filePath)) return filePath;
  const relativePath = filePath.replace(/^[/\\]+/, "");
  if (fs.existsSync(relativePath)) return relativePath;
  return path.resolve(process.cwd(), relativePath);
}

/**
 * Safely parses tool arguments regardless of whether they are already an object,
 * valid JSON, loose JSON, or single-quote strings.
 */
function parseToolArguments(raw: any): Record<string, any> {
  if (typeof raw === "object" && raw !== null) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // If it's a simple path or text
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return { file_path: trimmed, command: trimmed };
      }
      try {
        const fixed = trimmed
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        return JSON.parse(fixed);
      } catch {
        return {};
      }
    }
  }
  return {};
}

/**
 * Strips raw JSON tool call artifacts, Qwen internal XML tokens, and formats the final output cleanly.
 */
function cleanAssistantContent(text: string): string {
  if (!text) return "";
  let clean = text.trim();

  // Strip markdown ```json { ... } ``` tool call blocks
  clean = clean.replace(
    /```(?:json)?\s*\{[\s\S]*?"name"[\s\S]*?\}\s*```\s*/gi,
    "",
  );
  // Strip raw JSON tool call blocks
  clean = clean.replace(/^\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}\s*/gi, "");
  // Strip Qwen internal XML tags like <tool_response>, <nil>, etc.
  clean = clean.replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "");
  clean = clean.replace(/<[^>]+>/g, "").trim();

  // If only Qwen <none> token or empty after cleaning
  if (!clean || clean.includes("<none>") || clean.includes('"none"')) {
    clean = "✅ Action completed successfully.";
  }

  return clean.trim();
}

// JSON-RPC 2.0 request structure
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
};

// JSON-RPC 2.0 response structure
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
};

/**
 * Runs the CLI mode: processes a single prompt and returns the response.
 * Uses the shared agentic loop to handle tool calls until completion.
 */
async function runCliMode(prompt: string) {
  const result = await runAgentMode(prompt, []);
  process.stdout.write(result + "\n");
}

/**
 * Runs the agent mode: maintains a session and processes prompts with tool calls.
 * Returns the final response from Claude as a string.
 */
async function runAgentMode(prompt: string, messages: any[]): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const model = process.env.MODEL;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  // Ensure system prompt is present
  if (messages.length === 0 || messages[0].role !== "system") {
    messages.unshift({
      role: "system",
      content:
        "You are Claude Code, an expert coding assistant. Give direct, concise, and clean answers in Markdown. Do NOT include raw JSON tool calls in your final user response.",
    });
  }

  // Add user prompt to session messages
  messages.push({ role: "user", content: prompt });

  while (true) {
    // Call Claude API with available tools
    const response = await client.chat.completions.create({
      model: model ?? "anthropic/claude-haiku-4.5",
      messages: messages as any,
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read and return the content of a file",
            parameters: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
              required: ["file_path"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Write",
            description: "Write the content to a file",
            parameters: {
              type: "object",
              required: ["file_path", "content"],
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file to write",
                },
                content: {
                  type: "string",
                  description: "The content to write to the file",
                },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Execute a shell command",
            parameters: {
              type: "object",
              required: ["command"],
              properties: {
                command: {
                  type: "string",
                  description: "The shell command to execute",
                },
              },
            },
          },
        },
      ],
    });

    const message = response.choices[0].message;
    messages.push(message as any);

    // 1. Collect native tool calls or parse from message.content
    let toolCalls: any[] = message.tool_calls ?? [];

    if (toolCalls.length === 0 && message.content) {
      try {
        // Strip ```json and ``` markdown code fences if present
        let cleanText = message.content.trim();
        if (cleanText.startsWith("```")) {
          cleanText = cleanText
            .replace(/^```(?:json)?\n?/, "")
            .replace(/\n?```$/, "")
            .trim();
        }

        if (cleanText.startsWith("{") && cleanText.endsWith("}")) {
          const parsed = JSON.parse(cleanText);
          if (
            parsed.name &&
            parsed.name !== "<none>" &&
            parsed.name !== "none" &&
            (parsed.arguments || parsed.parameters)
          ) {
            toolCalls = [
              {
                id: "call_" + Math.random().toString(36).substring(2, 9),
                type: "function",
                function: {
                  name: parsed.name,
                  arguments:
                    typeof parsed.arguments === "string"
                      ? parsed.arguments
                      : JSON.stringify(
                          parsed.arguments ?? parsed.parameters ?? {},
                        ),
                },
              },
            ];
          }
        }
      } catch {
        // Not a JSON tool call, treat as normal text content
      }
    }

    // 2. Exit loop if no tool calls are requested
    if (toolCalls.length === 0) {
      if (message.content) {
        return cleanAssistantContent(message.content);
      }
      break;
    }

    // 3. Process each tool call
    for (const toolCall of toolCalls) {
      const args = parseToolArguments(toolCall.function?.arguments);

      const cleanArgs = { ...args };

      if (cleanArgs.content) {
        cleanArgs.content = `[${cleanArgs.content.length} characters omitted]`;
      }

      const toolName = toolCall.function?.name ?? "Unknown";
      const summary =
        toolName === "Read"
          ? `📖 Reading ${cleanArgs.file_path ?? "file"}`
          : toolName === "Write"
            ? `📝 Writing ${cleanArgs.file_path ?? "file"}`
            : `⚡ Running: ${cleanArgs.command ?? ""}`;

      // Emit JSON-RPC notification about the tool call
      const notification = {
        jsonrpc: "2.0",
        method: "session/tool_call",
        params: {
          tool: toolName,
          summary: summary,
          args: cleanArgs,
        },
      };
      process.stdout.write(JSON.stringify(notification) + "\n");

      // Execute the tool call and add result to conversation
      if (toolCall.function?.name === "Read") {
        const filePath = resolveFilePath(args.file_path);

        let fileContent: string;
        try {
          fileContent = fs.readFileSync(filePath, "utf-8");
        } catch (error: any) {
          fileContent = `Error reading file ${filePath}: ${error.message}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: fileContent,
        });
      }

      if (toolCall.function?.name === "Write") {
        const filePath = resolveFilePath(args.file_path);
        const content = args.content ?? "";

        let writeResult: string;
        try {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          fs.writeFileSync(filePath, content, "utf-8");
          writeResult = `File ${filePath} has been written successfully.`;
        } catch (error: any) {
          writeResult = `Error writing file ${filePath}: ${error.message}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: writeResult,
        });
      }

      if (toolCall.function?.name === "Bash") {
        const command = args.command;
        let bashResult: string;
        try {
          bashResult = await new Promise<string>((resolve) => {
            require("child_process").exec(
              command,
              (error: any, stdout: string, stderr: string) => {
                if (error) {
                  resolve(`Error: ${stderr || error.message}`);
                } else {
                  resolve(stdout);
                }
              },
            );
          });
        } catch (error: any) {
          bashResult = `Error executing bash: ${error.message}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: bashResult,
        });
      }
    }
  }
}

/**
 * Runs the server mode: listens for JSON-RPC requests and processes them accordingly.
 * Supports initialize, ping, and session/prompt methods.
 */
async function runServerMode() {
  const sessionMessages: any[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  // Process incoming JSON-RPC requests
  for await (const line of rl) {
    if (!line.trim()) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      const parseError: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      };
      process.stdout.write(JSON.stringify(parseError) + "\n");
      continue;
    }

    // Handle initialize request
    if (request.method === "initialize") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          protocolVersion: "2026-08-30",
          agentInfo: {
            name: "Claude Code",
            version: "1.0.0",
          },
          capabilities: {
            tools: ["Read", "Write", "Bash"],
          },
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    }
    // Handle ping request
    else if (request.method === "ping") {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: "pong",
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    }
    // Handle session prompt request
    else if (request.method === "session/prompt") {
      const userPrompt = request.params?.prompt ?? "";

      try {
        const result = await runAgentMode(userPrompt, sessionMessages);

        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            content: result,
          },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } catch (error: any) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: {
            code: -32000,
            message: error.message ?? "Internal error",
          },
        };
        process.stdout.write(JSON.stringify(errorResponse) + "\n");
      }
    }
    // Handle unknown method
    else {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32601,
          message: "Method not found",
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  }
}

/**
 * Main entry point: determines whether to run in CLI mode or server mode.
 * CLI mode: -p <prompt> runs a single prompt and exits.
 * Server mode: listens for JSON-RPC requests on stdin.
 */
async function main() {
  const args = process.argv.slice(2);
  const pIndex = args.indexOf("-p");

  if (pIndex !== -1 && args[pIndex + 1]) {
    await runCliMode(args[pIndex + 1]);
  } else {
    await runServerMode();
  }
}

main();
