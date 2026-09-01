import path from "node:path";
import * as readline from "node:readline";
import { runAgentMode } from "./agent.ts";
import {
  createNewSessionPath,
  deleteSessionById,
  getSessionFileByID,
  listAllSessions,
  loadSessionMessages,
} from "./session.ts";

// JSON-RPC 2.0 types
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

// Headless JSON-RPC server mode over stdio
export async function runServerMode() {
  let currentSessionFile = createNewSessionPath();
  let sessionMessages: any[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  const send = (obj: JsonRpcResponse) =>
    process.stdout.write(JSON.stringify(obj) + "\n");

  for await (const line of rl) {
    if (!line.trim()) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }

    const id = req.id ?? null;

    switch (req.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2026-08-30",
            agentInfo: {
              name: process.env.AGENT_NAME ?? "AI Coding Agent",
              version: "1.0.0",
            },
            capabilities: { tools: ["Read", "Write", "Bash", "WebSearch"] },
          },
        });
        break;

      case "ping":
        send({ jsonrpc: "2.0", id, result: "pong" });
        break;

      case "session/new":
        currentSessionFile = createNewSessionPath();
        sessionMessages = [];
        send({
          jsonrpc: "2.0",
          id,
          result: { sessionId: path.basename(currentSessionFile, ".jsonl") },
        });
        break;

      case "session/list":
        send({ jsonrpc: "2.0", id, result: { sessions: listAllSessions() } });
        break;

      case "session/resume": {
        const targetId = req.params?.sessionId;
        const target = getSessionFileByID(targetId);
        if (!target) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32001, message: `Session not found: ${targetId}` },
          });
        } else {
          currentSessionFile = target;
          sessionMessages = loadSessionMessages(target);
          send({
            jsonrpc: "2.0",
            id,
            result: {
              sessionId: targetId,
              messageCount: sessionMessages.length,
            },
          });
        }
        break;
      }

      case "session/prompt": {
        const userPrompt: string = req.params?.prompt ?? "";
        const notifyTool = (toolName: string, summary: string) => {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/tool_call",
              params: { tool: toolName, summary },
            }) + "\n",
          );
        };
        try {
          const result = await runAgentMode(
            userPrompt,
            sessionMessages,
            currentSessionFile,
            "server",
            notifyTool,
          );
          send({ jsonrpc: "2.0", id, result: { content: result } });
        } catch (e: any) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: e.message ?? "Internal error" },
          });
        }
        break;
      }

      case "session/delete": {
        const targetId = req.params?.sessionId;
        if (deleteSessionById(targetId)) {
          send({
            jsonrpc: "2.0",
            id,
            result: { deleted: true, sessionId: targetId },
          });
        } else {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32001, message: `Session not found: ${targetId}` },
          });
        }
        break;
      }

      default:
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  }
}
