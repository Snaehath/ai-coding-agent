import fs from "node:fs";
import path from "node:path";
import type {
  DatabaseAdapter,
  DatabaseEngine,
  ConnectionTestResult,
  SavedConnectionsConfig,
} from "./types.ts";
import { PostgresAdapter } from "./adapters/postgres-adapter.ts";
import { MysqlAdapter } from "./adapters/mysql-adapter.ts";
import { SqliteAdapter } from "./adapters/sqlite-adapter.ts";

export const CONNECTIONS_CONFIG_PATH = path.resolve(
  process.cwd(),
  ".agents",
  "connections.json",
);

export class DatabaseManager {
  private activeAdapter: DatabaseAdapter | null = null;
  private activeInfo: ConnectionTestResult | null = null;
  private activeUrlOrPath: string = "";

  // Auto-detect engine from connection string or file path
  detectEngine(urlOrPath: string): DatabaseEngine {
    const trimmed = urlOrPath.trim();
    if (/^postgres(?:ql)?:\/\//i.test(trimmed)) {
      return "postgres";
    }
    if (/^mysql2?:\/\//i.test(trimmed)) {
      return "mysql";
    }
    if (
      /^sqlite:\/\//i.test(trimmed) ||
      /\.(?:db|sqlite|sqlite3|db3)$/i.test(trimmed)
    ) {
      return "sqlite";
    }
    // Default fallback to postgres if URL pattern, else sqlite
    return trimmed.includes("://") ? "postgres" : "sqlite";
  }

  // Create appropriate adapter instance
  createAdapter(urlOrPath: string, engine?: DatabaseEngine): DatabaseAdapter {
    const selectedEngine = engine || this.detectEngine(urlOrPath);
    switch (selectedEngine) {
      case "postgres":
        return new PostgresAdapter(urlOrPath);
      case "mysql":
        return new MysqlAdapter(urlOrPath);
      case "sqlite":
        return new SqliteAdapter(urlOrPath);
      default:
        throw new Error(`Unsupported database engine: ${selectedEngine}`);
    }
  }

  // Connect, test latency, and cache active adapter
  async connect(urlOrPath: string): Promise<ConnectionTestResult> {
    // Disconnect any existing adapter first
    await this.disconnect();

    const adapter = this.createAdapter(urlOrPath);
    const testResult = await adapter.testConnection();

    if (testResult.ok) {
      this.activeAdapter = adapter;
      this.activeInfo = testResult;
      this.activeUrlOrPath = urlOrPath;

      // Update active profile in .agents/connections.json
      this.recordActiveConnection(urlOrPath, testResult.engine);
    } else {
      await adapter.disconnect();
    }

    return testResult;
  }

  // Disconnect active database
  async disconnect(): Promise<void> {
    if (this.activeAdapter) {
      await this.activeAdapter.disconnect();
      this.activeAdapter = null;
      this.activeInfo = null;
      this.activeUrlOrPath = "";
    }
  }

  // Get active adapter
  getActiveAdapter(): DatabaseAdapter | null {
    return this.activeAdapter;
  }

  // Get active connection test result / stats
  getActiveInfo(): ConnectionTestResult | null {
    return this.activeInfo;
  }

  // Get active connection string or file path
  getActiveUrl(): string {
    return this.activeUrlOrPath;
  }

  // Check if connected
  isConnected(): boolean {
    return this.activeAdapter !== null;
  }

  // Load saved connection profiles from .agents/connections.json
  loadConfig(): SavedConnectionsConfig {
    if (!fs.existsSync(CONNECTIONS_CONFIG_PATH)) {
      return { connections: {} };
    }
    try {
      const content = fs.readFileSync(CONNECTIONS_CONFIG_PATH, "utf-8");
      return JSON.parse(content);
    } catch {
      return { connections: {} };
    }
  }

  // Save config
  saveConfig(config: SavedConnectionsConfig): void {
    const dir = path.dirname(CONNECTIONS_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      CONNECTIONS_CONFIG_PATH,
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  // Save named connection profile
  saveProfile(name: string, url: string, description?: string): void {
    const config = this.loadConfig();
    const engine = this.detectEngine(url);
    config.connections[name] = {
      url,
      engine,
      description: description || `Saved ${engine} profile`,
      addedAt: new Date().toISOString(),
    };
    this.saveConfig(config);
  }

  // Delete profile
  deleteProfile(name: string): boolean {
    const config = this.loadConfig();
    if (config.connections[name]) {
      delete config.connections[name];
      if (config.active === name) config.active = undefined;
      this.saveConfig(config);
      return true;
    }
    return false;
  }

  // Connect using saved profile name
  async useProfile(name: string): Promise<ConnectionTestResult> {
    const config = this.loadConfig();
    const entry = config.connections[name];
    if (!entry) {
      return {
        ok: false,
        latencyMs: 0,
        engine: "postgres",
        tableCount: 0,
        error: `Profile '${name}' not found in .agents/connections.json`,
      };
    }

    const res = await this.connect(entry.url);
    if (res.ok) {
      config.active = name;
      this.saveConfig(config);
    }
    return res;
  }

  // Automatically connect from configured active profile or environment
  async autoConnect(): Promise<ConnectionTestResult | null> {
    const config = this.loadConfig();
    if (config.active && config.connections[config.active]) {
      return await this.connect(config.connections[config.active].url);
    }

    const envUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (envUrl) {
      return await this.connect(envUrl);
    }

    return null;
  }

  private recordActiveConnection(url: string, engine: DatabaseEngine): void {
    try {
      const config = this.loadConfig();
      // If matches any named connection, update active key
      let matchedName: string | undefined;
      for (const [name, c] of Object.entries(config.connections)) {
        if (c.url === url) {
          matchedName = name;
          break;
        }
      }
      if (matchedName) {
        config.active = matchedName;
        this.saveConfig(config);
      }
    } catch {
      // ignore
    }
  }

  // Format connection result for terminal output
  formatConnectionCard(res: ConnectionTestResult, url: string): string {
    if (!res.ok) {
      return `❌ Database Connection Failed:\n  • Error: ${res.error}\n  • Latency: ${res.latencyMs}ms`;
    }

    const maskedUrl = url.replace(/:([^@/]+)@/, ":****@");
    const lines: string[] = [
      `✅ Database Connected Successfully!`,
      `  • Engine   : ${res.version || res.engine.toUpperCase()}`,
      `  • Database : ${res.database || "default"}`,
      `  • Latency  : ${res.latencyMs}ms`,
      `  • Target   : ${maskedUrl}`,
      `  • Tables   : ${res.tableCount} table(s) discovered:`,
    ];

    if (res.tables && res.tables.length > 0) {
      for (const t of res.tables.slice(0, 10)) {
        let rowStr = "";
        if (t.approxRows !== undefined) {
          rowStr = t.isExactRows
            ? ` (${t.approxRows} rows)`
            : ` (~${t.approxRows} rows)`;
        }
        lines.push(`     • 📄 ${t.name}${rowStr}`);
      }
      if (res.tables.length > 10) {
        lines.push(`     ...and ${res.tables.length - 10} more tables.`);
      }
    } else {
      lines.push(`     (No user tables found in database)`);
    }

    lines.push(`\n🔌 Read-only AI database tools (list_tables, describe_table, read_query) are active!`);
    return lines.join("\n");
  }
}

// Global Singleton Instance
export const dbManager = new DatabaseManager();
