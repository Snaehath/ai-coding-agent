import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// Types
export type LspPosition = {
  line: number; // 0-indexed
  character: number; // 0-indexed
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type LspSymbol = {
  name: string;
  kind: number;
  kindName?: string;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspSymbol[];
};

// Symbol kind mapping helper
export function getSymbolKindName(kind: number): string {
  const kinds: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return kinds[kind] ?? "Symbol";
}

// Convert file path to file:// URI
export function pathToUri(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return resolved.startsWith("/") ? `file://${resolved}` : `file:///${resolved}`;
}

// Convert file:// URI to file path
export function uriToPath(uri: string): string {
  let p = uri.replace(/^file:\/\/\/?/, "");
  if (process.platform === "win32" && !/^[a-zA-Z]:/.test(p)) {
    p = "/" + p;
  }
  return path.normalize(decodeURIComponent(p));
}

// Language Server Protocol JSON-RPC Client
export class LspClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (res: any) => void; reject: (err: any) => void }
  >();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  public readonly serverId: string;
  public readonly rootPath: string;

  constructor(
    serverId: string,
    private command: string,
    private args: string[] = [],
    rootPath: string = process.cwd(),
  ) {
    this.serverId = serverId;
    this.rootPath = path.resolve(rootPath);
  }

  // Connect and execute LSP handshake
  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          cwd: this.rootPath,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        });

        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.handleData(chunk);
        });

        this.process.stderr?.on("data", () => {
          // Keep stderr open for server diagnostics
        });

        this.process.on("error", (err) => {
          if (!this.initialized) reject(err);
        });

        this.process.on("exit", () => {
          for (const { reject } of this.pendingRequests.values()) {
            reject(new Error("LSP server terminated"));
          }
          this.pendingRequests.clear();
        });

        // Initialize handshake
        this.sendRequest("initialize", {
          processId: process.pid,
          rootUri: pathToUri(this.rootPath),
          rootPath: this.rootPath,
          capabilities: {
            textDocument: {
              definition: { dynamicRegistration: true },
              references: { dynamicRegistration: true },
              hover: {
                dynamicRegistration: true,
                contentFormat: ["markdown", "plaintext"],
              },
              documentSymbol: {
                dynamicRegistration: true,
                hierarchicalDocumentSymbolSupport: true,
              },
              synchronization: {
                openClose: true,
                change: 1, // Full document sync
              },
            },
            workspace: {
              symbol: { dynamicRegistration: true },
            },
          },
        })
          .then(() => {
            this.sendNotification("initialized", {});
            this.initialized = true;
            resolve();
          })
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  // Parse incoming Content-Length: <bytes>\r\n\r\n<json> stream
  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerText = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) {
        // Body not fully received yet; wait for next chunk
        break;
      }

      const bodyBuffer = this.buffer.subarray(bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const message = JSON.parse(bodyBuffer.toString("utf-8"));
        this.handleMessage(message);
      } catch (e: any) {
        process.stderr.write(`[LSP Parse Error] ${e.message}\n`);
      }
    }
  }

  // Dispatch incoming JSON-RPC response
  private handleMessage(msg: any): void {
    if (typeof msg.id === "number" && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  // Send request with Content-Length framing
  public sendRequest<T = any>(method: string, params: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      const body = Buffer.from(payload, "utf-8");
      const header = Buffer.from(
        `Content-Length: ${body.length}\r\n\r\n`,
        "utf-8",
      );

      this.process?.stdin?.write(Buffer.concat([header, body]));
    });
  }

  // Send notification without expecting a response
  public sendNotification(method: string, params: any): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });

    const body = Buffer.from(payload, "utf-8");
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\n\r\n`,
      "utf-8",
    );

    this.process?.stdin?.write(Buffer.concat([header, body]));
  }

  // Terminate LSP server
  public close(): void {
    try {
      this.sendNotification("exit", {});
      this.process?.kill();
    } catch {
      // Ignored
    }
  }
}
