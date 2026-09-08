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
import { ANSI } from "../markdown.ts";

export const CONNECTIONS_CONFIG_PATH = path.resolve(
  process.cwd(),
  ".agents",
  "connections.json",
);

export class DatabaseManager {
  private activeAdapter: DatabaseAdapter | null = null;
  private activeInfo: ConnectionTestResult | null = null;
  private activeUrlOrPath: string = "";

  /**
   * Resolve the actual connection URL for a saved profile.
   * Prefers `envKey` (looks up from process.env) over the inline `url` field.
   * Throws if neither is set or the env var is missing.
   */
  private resolveConnectionUrl(entry: { envKey?: string; url?: string }): string {
    if (entry.envKey) {
      const resolved = process.env[entry.envKey];
      if (!resolved) {
        throw new Error(
          `Connection env var "${entry.envKey}" is not set. Add it to your .env file.`,
        );
      }
      return resolved;
    }
    if (entry.url) return entry.url;
    throw new Error("Connection entry has neither envKey nor url set.");
  }

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

    let url: string;
    try {
      url = this.resolveConnectionUrl(entry);
    } catch (e: any) {
      return { ok: false, latencyMs: 0, engine: entry.engine ?? "postgres", tableCount: 0, error: e.message };
    }

    const res = await this.connect(url);
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
      try {
        const url = this.resolveConnectionUrl(config.connections[config.active]);
        return await this.connect(url);
      } catch {
        // If env var is missing, fall through to DATABASE_URL fallback
      }
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
      // Match against resolved URL for each named profile
      let matchedName: string | undefined;
      for (const [name, c] of Object.entries(config.connections)) {
        try {
          if (this.resolveConnectionUrl(c) === url) {
            matchedName = name;
            break;
          }
        } catch {
          // env var not set for this profile — skip
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

    lines.push(`\n🔌 Read-only AI database tools (list_tables, describe_table, preview_table, get_table_relationships, search_columns, explain_query, read_query) are active!`);
    return lines.join("\n");
  }

  // Unified CLI & REPL database command handler (eliminates duplicate logic across main.ts and repl.ts)
  async handleCliCommand(sub: string, target: string = ""): Promise<void> {
    const s = (sub || "").toLowerCase().trim();
    const t = (target || "").trim();

    if (!s || s === "status" || s === "help") {
      await this.autoConnect();
      const active = this.getActiveInfo();
      const config = this.loadConfig();
      console.log("\n" + ANSI.bold("Database Connector Status:"));
      console.log(ANSI.gray("─".repeat(68)));
      if (active && active.ok) {
        console.log(
          `  • Status   : ${ANSI.boldGreen("CONNECTED")}\n` +
          `  • Engine   : ${ANSI.cyan(active.version || active.engine.toUpperCase())}\n` +
          `  • Database : ${ANSI.bold(active.database || "default")}\n` +
          `  • Latency  : ${ANSI.yellow(`${active.latencyMs}ms`)}\n` +
          `  • Tables   : ${active.tableCount} table(s) discovered\n` +
          `  • Target   : ${ANSI.dim(this.getActiveUrl().replace(/:([^@/]+)@/, ":****@"))}`
        );
      } else {
        console.log(`  • Status   : ${ANSI.yellow("DISCONNECTED")}`);
        if (config.active) {
          console.log(`  • Default  : Profile '${config.active}' (type '/db use ${config.active}' or 'bun app/main.ts db use ${config.active}' to connect)`);
        }
      }

      console.log(
        `\n${ANSI.bold("Available Subcommands:")}\n` +
        `  ${ANSI.boldYellow("/db connect <url|path>")}  Connect to PostgreSQL, MySQL, or SQLite\n` +
        `  ${ANSI.boldYellow("/db test")}                Test connection health & latency\n` +
        `  ${ANSI.boldYellow("/db tables")}              List available tables with row counts\n` +
        `  ${ANSI.boldYellow("/db schema [table]")}     Inspect table columns or full schema\n` +
        `  ${ANSI.boldYellow("/db preview <table> [n]")} Preview sample rows (default 3)\n` +
        `  ${ANSI.boldYellow("/db relationships [t]")}  Discover foreign key relationships\n` +
        `  ${ANSI.boldYellow("/db search <col>")}        Find which tables have a column\n` +
        `  ${ANSI.boldYellow("/db explain <sql>")}       Explain execution plan of a query\n` +
        `  ${ANSI.boldYellow("/db save <name> <url>")}   Save named connection profile\n` +
        `  ${ANSI.boldYellow("/db use <name>")}          Switch to saved profile\n` +
        `  ${ANSI.boldYellow("/db profiles")}            List all saved connection profiles\n` +
        `  ${ANSI.boldYellow("/db disconnect")}          Disconnect active database\n`
      );
      return;
    }

    if (s === "connect") {
      if (!t) {
        console.log(ANSI.red("\nUsage: /db connect <postgresql://... | mysql://... | ./local.db>\n"));
        return;
      }
      console.log(ANSI.dim(`\n  ⚡ Testing connection to database...`));
      const res = await this.connect(t);
      console.log("\n" + this.formatConnectionCard(res, t) + "\n");
      return;
    }

    if (s === "test") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      console.log(ANSI.dim(`\n  ⚡ Testing database latency & health...`));
      const test = await adapter.testConnection();
      if (test.ok) {
        console.log(ANSI.green(`\n✅ Database is healthy (${test.latencyMs}ms) · ${test.tableCount} table(s) accessible.\n`));
      } else {
        console.log(ANSI.red(`\n❌ Health check failed: ${test.error} (${test.latencyMs}ms)\n`));
      }
      return;
    }

    if (s === "tables" || s === "list") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      try {
        const tables = await adapter.listTables();
        console.log(`\n${ANSI.bold(`Available Tables (${tables.length} total):`)}`);
        console.log(ANSI.gray("─".repeat(68)));
        for (const tbl of tables) {
          const rows =
            tbl.approxRows !== undefined
              ? ANSI.dim(tbl.isExactRows ? ` (${tbl.approxRows} rows)` : ` (~${tbl.approxRows} rows)`)
              : "";
          console.log(`  • 📄 ${ANSI.boldCyan(tbl.name)}${rows} ${ANSI.gray(`[${tbl.type}]`)}`);
        }
        console.log();
      } catch (err: any) {
        console.log(ANSI.red(`\n❌ Error fetching tables: ${err.message}\n`));
      }
      return;
    }

    if (s === "schema") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      try {
        if (t) {
          const cols = await adapter.describeTable(t);
          console.log(`\n${ANSI.bold(`Table Schema: ${t} (${cols.length} columns):`)}`);
          console.log(ANSI.gray("─".repeat(68)));
          for (const c of cols) {
            const pk = c.isPrimaryKey ? ANSI.boldYellow(" [PRIMARY KEY]") : "";
            const nullStr = c.nullable ? ANSI.dim("NULL") : ANSI.bold("NOT NULL");
            const def = c.defaultValue ? ANSI.gray(` DEFAULT ${c.defaultValue}`) : "";
            console.log(`  • ${ANSI.boldCyan(c.name)}: ${c.type} (${nullStr}${pk}${def})`);
          }
          console.log();
        } else {
          const fullSchema = await adapter.getSchema();
          console.log("\n" + fullSchema + "\n");
        }
      } catch (err: any) {
        console.log(ANSI.red(`\n❌ Error fetching schema: ${err.message}\n`));
      }
      return;
    }

    if (s === "preview") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      const [tbl, limitStr] = t.split(/\s+/, 2);
      if (!tbl) {
        console.log(ANSI.red("\nUsage: /db preview <table_name> [limit]\n"));
        return;
      }
      const limit = limitStr ? parseInt(limitStr, 10) : 3;
      try {
        const rows = await adapter.previewTable(tbl, isNaN(limit) ? 3 : limit);
        console.log(`\n${ANSI.bold(`Preview of '${tbl}' (${rows.length} row(s)):`)}`);
        console.log(ANSI.gray("─".repeat(68)));
        if (rows.length === 0) {
          console.log(ANSI.gray("  (No rows found in table)"));
        } else {
          console.log(JSON.stringify(rows, null, 2));
        }
        console.log();
      } catch (err: any) {
        console.log(ANSI.red(`\n❌ Error previewing table: ${err.message}\n`));
      }
      return;
    }

    if (s === "relationships" || s === "fk" || s === "relations") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      try {
        const rels = await adapter.getRelationships(t || undefined);
        console.log(`\n${ANSI.bold(`Table Relationships (${rels.length} constraint(s)):`)}`);
        console.log(ANSI.gray("─".repeat(68)));
        if (rels.length === 0) {
          console.log(ANSI.gray("  (No foreign key relationships detected)"));
        } else {
          for (const r of rels) {
            console.log(
              `  • ${ANSI.boldCyan(r.fromTable)}.${ANSI.yellow(r.fromColumn)} ➔ ` +
              `${ANSI.boldCyan(r.toTable)}.${ANSI.yellow(r.toColumn)} ` +
              `${ANSI.gray(`(${r.constraintName})`)}`
            );
          }
        }
        console.log();
      } catch (err: any) {
        console.log(ANSI.red(`\n❌ Error fetching relationships: ${err.message}\n`));
      }
      return;
    }

    if (s === "search" || s === "find-col") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      if (!t) {
        console.log(ANSI.red("\nUsage: /db search <column_keyword>\n"));
        return;
      }
      try {
        const matches = await adapter.searchColumns(t);
        console.log(`\n${ANSI.bold(`Columns matching '${t}' (${matches.length} found):`)}`);
        console.log(ANSI.gray("─".repeat(68)));
        if (matches.length === 0) {
          console.log(ANSI.gray(`  (No columns matching '${t}')`));
        } else {
          for (const m of matches) {
            const pk = m.isPrimaryKey ? ANSI.boldYellow(" [PK]") : "";
            console.log(`  • ${ANSI.boldCyan(m.table)}.${ANSI.yellow(m.column)} ${ANSI.gray(`(${m.type})`)}${pk}`);
          }
        }
        console.log();
      } catch (err: any) {
        console.log(ANSI.red(`\n❌ Error searching columns: ${err.message}\n`));
      }
      return;
    }

    if (s === "explain") {
      await this.autoConnect();
      const adapter = this.getActiveAdapter();
      if (!adapter) {
        console.log(ANSI.yellow("\n⚠️ No active database connection. Connect using '/db connect <url>'\n"));
        return;
      }
      if (!t) {
        console.log(ANSI.red("\nUsage: /db explain <SELECT query>\n"));
        return;
      }
      try {
        console.log(ANSI.dim(`\n  ⚡ Explaining query execution plan...`));
        const plan = await adapter.explainQuery(t);
        console.log(`\n${ANSI.bold("Execution Plan:")}`);
        console.log(ANSI.gray("─".repeat(68)));
        console.log(plan);
        console.log();
      } catch (err: any) {
        console.log(ANSI.red(`\n❌ Error explaining query: ${err.message}\n`));
      }
      return;
    }

    if (s === "disconnect") {
      await this.disconnect();
      console.log(ANSI.green("\n🔌 Database disconnected successfully.\n"));
      return;
    }

    if (s === "save") {
      const [pName, pUrl] = t.split(/\s+/, 2);
      if (!pName || !pUrl) {
        console.log(ANSI.red("\nUsage: /db save <profile_name> <connection_url>\n"));
        return;
      }
      this.saveProfile(pName, pUrl);
      console.log(ANSI.green(`\n✅ Saved profile '${pName}' in .agents/connections.json\n`));
      return;
    }

    if (s === "use" || s === "switch") {
      if (!t) {
        console.log(ANSI.red("\nUsage: /db use <profile_name>\n"));
        return;
      }
      console.log(ANSI.dim(`\n  ⚡ Connecting to profile '${t}'...`));
      const res = await this.useProfile(t);
      if (res.ok) {
        const cfg = this.loadConfig();
        const url = cfg.connections[t]?.url || t;
        console.log("\n" + this.formatConnectionCard(res, url) + "\n");
      } else {
        console.log(ANSI.red(`\n❌ Connection failed: ${res.error}\n`));
      }
      return;
    }

    if (s === "profiles") {
      const cfg = this.loadConfig();
      const entries = Object.entries(cfg.connections);
      console.log("\n" + ANSI.bold("Saved Connection Profiles:"));
      console.log(ANSI.gray("─".repeat(68)));
      if (entries.length === 0) {
        console.log(ANSI.gray("  (No saved profiles. Use '/db save <name> <url>' to add one)"));
      } else {
        for (const [pName, pData] of entries) {
          const isActive = cfg.active === pName;
          const badge = isActive ? ANSI.boldGreen(" [ACTIVE]") : "";
          const displayUrl = pData.envKey
            ? `env:${pData.envKey}`
            : (pData.url ?? "(no url)").replace(/:([^@/]+)@/, ":****@");
          console.log(`• ${ANSI.boldCyan(pName)}${badge} ${ANSI.gray(`(${pData.engine || "db"})`)}`);
          console.log(`  URL: ${ANSI.dim(displayUrl)}`);
          if (pData.description) console.log(`  Desc: ${ANSI.gray(pData.description)}`);
        }
      }
      console.log();
      return;
    }

    console.log(ANSI.red(`\nUnknown /db command: '${s}'. Type '/db' for help.\n`));
  }
}

// Global Singleton Instance
export const dbManager = new DatabaseManager();
