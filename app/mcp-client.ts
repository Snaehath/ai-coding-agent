import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";

// Types
export type McpToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type PendingCall = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
};

// McpClient class
export class McpClient {
  private readonly serverId: string;
  private readonly command: string;
  private readonly args: string[];

  private process: ChildProcess | null = null;
  private tools: McpToolSchema[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private rl: readline.Interface | null = null;

  constructor(serverId: string, command: string, args: string[] = []) {
    this.serverId = serverId;
    this.command = command;
    this.args = args;
  }

  // Connect to server process and discover tools
  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`McpClient[${this.serverId}]: failed to open stdio pipes`);
    }

    // Read responses
    this.rl = readline.createInterface({
      input: this.process.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(
            new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
          );
        } else {
          pending.resolve(msg.result);
        }
      } catch {
        // Ignore non-JSON output
      }
    });

    this.process.on("error", (err) => {
      this.rejectAll(err);
    });

    this.process.on("close", (code) => {
      if (code !== 0 && code !== null) {
        this.rejectAll(
          new Error(`McpClient[${this.serverId}]: server exited with code ${code}`),
        );
      }
    });

    // Initialize handshake
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "ai-coding-agent", version: "1.0.0" },
      capabilities: {},
    });

    // Fetch tool list
    const listResult = await this.call("tools/list", {});
    const rawTools: any[] = listResult?.tools ?? [];

    // Map tools with serverId namespace
    this.tools = rawTools.map((t: any) => ({
      type: "function",
      function: {
        name: `mcp__${this.serverId}__${t.name}`,
        description: `[MCP:${this.serverId}] ${t.description ?? t.name}`,
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  // Get discovered tools
  getTools(): McpToolSchema[] {
    return this.tools;
  }

  // Call tool on server
  async callTool(
    localName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.call("tools/call", {
      name: localName,
      arguments: args,
    });
    const content: any[] = result?.content ?? [];
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  // Send JSON-RPC request
  private call(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.process!.stdin!.write(payload + "\n");

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(
              `McpClient[${this.serverId}]: timeout waiting for "${method}"`,
            ),
          );
        }
      }, 10_000);
    });
  }

  // Reject pending calls on crash
  private rejectAll(err: Error) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  // Close connection
  close() {
    this.rl?.close();
    this.process?.kill();
    this.process = null;
  }
}
