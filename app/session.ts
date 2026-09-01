import fs from "node:fs";
import path from "node:path";

// Constants
export const SESSION_DIR = path.resolve(process.cwd(), ".agents", "sessions");
const MAX_CONTEXT_MESSAGES = 20;

// Types
export type SessionInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  title: string;
};

// Session directory helper
export function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Create new session file path
export function createNewSessionPath(): string {
  ensureSessionDir();
  return path.join(SESSION_DIR, `session_${Date.now()}.jsonl`);
}

// Append message to session file
export function appendSessionMessage(sessionFilePath: string, message: any) {
  ensureSessionDir();
  fs.appendFileSync(sessionFilePath, JSON.stringify(message) + "\n", { encoding: "utf-8" });
}

// Get most recently modified session file
export function getLatestSessionFile(): string | null {
  ensureSessionDir();
  const files = fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ p: path.join(SESSION_DIR, f), mtime: fs.statSync(path.join(SESSION_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].p : null;
}

// Load chat messages from session file (excluding telemetry records)
export function loadSessionMessages(sessionFilePath: string): any[] {
  if (!fs.existsSync(sessionFilePath)) return [];
  return fs
    .readFileSync(sessionFilePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const obj = JSON.parse(l);
        if (obj.type === "telemetry") return [];
        return [obj];
      } catch {
        return [];
      }
    });
}

// Get session file by ID
export function getSessionFileByID(sessionId: string): string {
  ensureSessionDir();
  const fullPath = path.join(
    SESSION_DIR,
    `${sessionId.replace(/\.jsonl$/, "")}.jsonl`,
  );
  return fs.existsSync(fullPath) ? fullPath : "";
}

// List all non-empty sessions
export function listAllSessions(): SessionInfo[] {
  ensureSessionDir();
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fullPath = path.join(SESSION_DIR, f);
      const stat = fs.statSync(fullPath);
      const messages = loadSessionMessages(fullPath);
      const lastUser = messages.filter((m) => m.role === "user").at(-1);
      return {
        id: f.replace(/\.jsonl$/, ""),
        createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        messageCount: messages.length,
        title:
          (lastUser?.content as string | undefined)?.slice(0, 50) ??
          "Empty Session",
      };
    })
    .filter((s) => s.messageCount > 0)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

// Delete session by ID
export function deleteSessionById(sessionId: string): boolean {
  const target = getSessionFileByID(sessionId);
  if (target) {
    fs.unlinkSync(target);
    return true;
  }
  return false;
}

// Overwrite session file with new message array (preserving telemetry records)
export function rewriteSessionFile(sessionFilePath: string, messages: any[]) {
  ensureSessionDir();
  let telemetryRecords: any[] = [];
  if (fs.existsSync(sessionFilePath)) {
    try {
      telemetryRecords = fs
        .readFileSync(sessionFilePath, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            const obj = JSON.parse(l);
            return obj.type === "telemetry" ? [obj] : [];
          } catch {
            return [];
          }
        });
    } catch {
      telemetryRecords = [];
    }
  }

  const content =
    [...messages, ...telemetryRecords]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n";
  fs.writeFileSync(sessionFilePath, content, { encoding: "utf-8" });
}

// Trim conversation context to max limit
export function trimContextMessages(messages: any[]): any[] {
  if (messages.length <= MAX_CONTEXT_MESSAGES) return messages;
  const sys = messages.find((m) => m.role === "system");
  const recent = messages.slice(-(MAX_CONTEXT_MESSAGES - 1));
  return sys ? [sys, ...recent] : recent;
}
