import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { dbManager, CONNECTIONS_CONFIG_PATH } from "../app/connectors/db-manager.ts";
import type { DatabaseAdapter } from "../app/connectors/types.ts";

// Resolve database connection URL
function resolveDbUrl(): string {
  // 1. Direct argument
  if (process.argv[2] && process.argv[2].trim()) {
    return process.argv[2].trim();
  }

  // 2. Saved connections config
  if (fs.existsSync(CONNECTIONS_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONNECTIONS_CONFIG_PATH, "utf-8"));
      if (config.active && config.connections[config.active]?.url) {
        return config.connections[config.active].url;
      }
    } catch {
      // ignore
    }
  }

  // 3. Environment variables
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

let activeAdapter: DatabaseAdapter | null = null;
let currentDbUrl = resolveDbUrl();

function getAdapter(): DatabaseAdapter {
  // If connection URL changed or not initialized, re-create
  const latestUrl = resolveDbUrl();
  if (!activeAdapter || (latestUrl && latestUrl !== currentDbUrl)) {
    currentDbUrl = latestUrl;
    if (!currentDbUrl) {
      throw new Error(
        "No database connection configured. Connect via '/db connect <url>' in REPL, pass '--db <url>', or set DATABASE_URL.",
      );
    }
    activeAdapter = dbManager.createAdapter(currentDbUrl);
  }
  return activeAdapter;
}

// Tool Schemas (Strictly Read-Only)
const TOOL_SCHEMAS = [
  {
    name: "list_tables",
    description:
      "Lists all user tables in the database with row counts. Strictly read-only.",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Database schema to inspect (defaults to 'public' on Postgres, or current DB on MySQL/SQLite).",
        },
      },
      required: [],
    },
  },
  {
    name: "describe_table",
    description:
      "Returns column names, data types, nullability, defaults, and primary key status for a table. Strictly read-only.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The name of the table to describe.",
        },
        schema: {
          type: "string",
          description: "Optional database schema.",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "get_database_schema",
    description:
      "Returns a compact full overview of all tables and their columns in the database schema. Ideal for planning queries. Strictly read-only.",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Optional database schema to inspect.",
        },
      },
      required: [],
    },
  },
  {
    name: "read_query",
    description:
      "Executes a strictly read-only SQL query (SELECT / WITH / EXPLAIN). For aggregate, analytical, or statistical questions (e.g. totals, sums, averages, counts, breakdowns), ALWAYS compute it on PostgreSQL using SQL functions (SUM, COUNT, AVG, MIN, MAX, GROUP BY) rather than retrieving individual rows. Do not inspect thousands of rows in prompt context.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The read-only SQL query to execute (e.g. 'SELECT bank, SUM(amount) FROM transaction GROUP BY bank;').",
        },
        max_rows: {
          type: "number",
          description: "Maximum number of rows to return (default: 50, max: 100).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_connection_info",
    description:
      "Returns details about the active database connection (engine, database name, latency).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// Helper: Format tabular output to Markdown
function formatMarkdownTable(rows: Record<string, any>[]): string {
  if (!rows || rows.length === 0) return "(0 rows returned)";
  const keys = Object.keys(rows[0]);
  if (keys.length === 0) return "(empty rows)";

  const header = `| ${keys.join(" | ")} |`;
  const divider = `| ${keys.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => {
    const vals = keys.map((k) => {
      const val = r[k];
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
    });
    return `| ${vals.join(" | ")} |`;
  });

  return [header, divider, ...body].join("\n");
}

// Handlers
async function handleListTables(args: Record<string, any>): Promise<string> {
  try {
    const adapter = getAdapter();
    const tables = await adapter.listTables(args.schema);

    if (tables.length === 0) {
      return `No user tables found in database.`;
    }

    const lines = tables.map((t) => {
      const rowInfo =
        t.approxRows !== undefined
          ? t.isExactRows
            ? ` (${t.approxRows} rows, exact)`
            : ` (~${t.approxRows} rows, estimated)`
          : "";
      return `  • 📄 ${t.name}${rowInfo} [${t.type}]`;
    });

    return `Database Tables (${tables.length} total, Engine: ${adapter.engine.toUpperCase()}):\n${lines.join("\n")}`;
  } catch (err: any) {
    return `Error listing tables: ${err.message}`;
  }
}

async function handleDescribeTable(args: Record<string, any>): Promise<string> {
  const tableName = String(args.table_name || "").trim();
  if (!tableName) return "Error: table_name parameter is required.";

  try {
    const adapter = getAdapter();
    const cols = await adapter.describeTable(tableName, args.schema);

    if (cols.length === 0) {
      return `Error: table "${tableName}" not found or has no columns.`;
    }

    const lines = cols.map((c) => {
      const pk = c.isPrimaryKey ? " [PRIMARY KEY]" : "";
      const nullable = c.nullable ? "NULL" : "NOT NULL";
      const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : "";
      return `  • ${c.name}: ${c.type} (${nullable}${pk}${def})`;
    });

    return `Table Schema: ${tableName} (${cols.length} columns, Engine: ${adapter.engine.toUpperCase()}):\n${lines.join("\n")}`;
  } catch (err: any) {
    return `Error describing table "${tableName}": ${err.message}`;
  }
}

async function handleGetDatabaseSchema(args: Record<string, any>): Promise<string> {
  try {
    const adapter = getAdapter();
    return await adapter.getSchema(args.schema);
  } catch (err: any) {
    return `Error retrieving database schema: ${err.message}`;
  }
}

async function handleReadQuery(args: Record<string, any>): Promise<string> {
  const rawQuery = String(args.query || "").trim();
  const maxRows = Math.min(Math.max(Number(args.max_rows) || 50, 1), 200);

  try {
    const adapter = getAdapter();
    const results = await adapter.readQuery(rawQuery, maxRows);
    const rowCount = results.length;
    const tableFormatted = formatMarkdownTable(results);

    const countNote =
      rowCount >= maxRows
        ? `\n\n*(Showing first ${rowCount} rows. TIP: If answering an aggregate or statistical question, compute it directly on the database using SQL functions SUM/COUNT/AVG/GROUP BY instead of inspecting raw rows)*`
        : `\n\n*(${rowCount} row${rowCount === 1 ? "" : "s"} returned)*`;

    return `Query:\n\`\`\`sql\n${rawQuery}\n\`\`\`\n\nResult:\n${tableFormatted}${countNote}`;
  } catch (err: any) {
    return `SQL Query Error: ${err.message}`;
  }
}

async function handleGetConnectionInfo(): Promise<string> {
  try {
    const adapter = getAdapter();
    const test = await adapter.testConnection();
    return JSON.stringify(test, null, 2);
  } catch (err: any) {
    return `Error retrieving connection info: ${err.message}`;
  }
}

// JSON-RPC Helpers
type JsonRpcId = number | string | null;

function respond(id: JsonRpcId, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id: JsonRpcId, code: number, message: string) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

// Stdio JSON-RPC Main Loop
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
        serverInfo: { name: "universal-db-mcp-server", version: "1.1.0" },
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
      try {
        if (toolName === "list_tables") {
          text = await handleListTables(toolArgs);
        } else if (toolName === "describe_table") {
          text = await handleDescribeTable(toolArgs);
        } else if (toolName === "get_database_schema") {
          text = await handleGetDatabaseSchema(toolArgs);
        } else if (toolName === "read_query") {
          text = await handleReadQuery(toolArgs);
        } else if (toolName === "get_connection_info") {
          text = await handleGetConnectionInfo();
        } else {
          respondError(id, -32601, `Unknown tool: ${toolName}`);
          break;
        }
      } catch (err: any) {
        text = `Internal error executing ${toolName}: ${err.message}`;
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
