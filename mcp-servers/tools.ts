import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";

// Tool schemas
const TOOL_SCHEMAS = [
  {
    name: "get_time",
    description: "Returns the current date, time, and local timezone.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_files",
    description:
      "Lists files and directories at the given path. Defaults to current directory.",
    inputSchema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Directory path to list. Defaults to '.' if omitted.",
        },
      },
      required: [],
    },
  },
];

// Tool handlers
function handleGetTime(): string {
  const now = new Date();
  return [
    `Date : ${now.toLocaleDateString("en-IN", { dateStyle: "full" })}`,
    `Time : ${now.toLocaleTimeString("en-IN", { timeStyle: "long" })}`,
    `ISO  : ${now.toISOString()}`,
  ].join("\n");
}

function handleListFiles(args: Record<string, any>): string {
  let rawDir = String(args.dir ?? ".").trim();
  let target = path.resolve(process.cwd(), rawDir);

  // Normalize relative path if leading slash was included
  if (!fs.existsSync(target)) {
    const relative = rawDir.replace(/^[/\\]+/, "");
    if (relative) {
      const relTarget = path.resolve(process.cwd(), relative);
      if (fs.existsSync(relTarget)) {
        target = relTarget;
      }
    }
  }

  try {
    if (!fs.existsSync(target)) {
      return `Error: path does not exist: ${target}`;
    }
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      return `Error: not a directory: ${target}`;
    }
    const entries = fs.readdirSync(target, { withFileTypes: true });
    if (entries.length === 0) return `(empty directory: ${target})`;

    const lines = entries.map((e) => {
      const size = e.isFile()
        ? ` (${fs.statSync(path.join(target, e.name)).size} bytes)`
        : "/";
      return `${e.isDirectory() ? "📁" : "📄"} ${e.name}${size}`;
    });
    return `Contents of ${target}:\n${lines.join("\n")}`;
  } catch (err: any) {
    return `Error listing ${target}: ${err.message}`;
  }
}

// JSON-RPC helpers
type JsonRpcId = number | string | null;

function respond(id: JsonRpcId, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id: JsonRpcId, code: number, message: string) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

// Stdio JSON-RPC loop
const rl = readline.createInterface({ input: process.stdin, terminal: false });

for await (const line of rl) {
  if (!line.trim()) continue;

  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    continue;
  }

  const { id = null, method, params = {} } = req;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "tools-mcp-server", version: "1.0.0" },
        capabilities: { tools: {} },
      });
      break;

    case "tools/list":
      respond(id, { tools: TOOL_SCHEMAS });
      break;

    case "tools/call": {
      const toolName: string = params.name ?? "";
      const toolArgs: Record<string, any> = params.arguments ?? {};

      let text: string;
      if (toolName === "get_time") {
        text = handleGetTime();
      } else if (toolName === "list_files") {
        text = handleListFiles(toolArgs);
      } else {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        break;
      }

      respond(id, {
        content: [{ type: "text", text }],
      });
      break;
    }

    case "ping":
      respond(id, "pong");
      break;

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}
