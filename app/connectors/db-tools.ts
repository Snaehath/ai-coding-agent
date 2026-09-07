import type OpenAI from "openai";
import { dbManager } from "./db-manager.ts";
import type { DatabaseAdapter } from "./types.ts";

async function getOrInitAdapter(): Promise<DatabaseAdapter> {
  let adapter = dbManager.getActiveAdapter();
  if (!adapter) {
    const res = await dbManager.autoConnect();
    adapter = dbManager.getActiveAdapter();
    if (!adapter) {
      throw new Error(
        res?.error ||
          "No active database connection found. Connect via '/db connect <url>' in REPL, '--db <url>', or configure .agents/connections.json.",
      );
    }
  }
  return adapter;
}

// Native Database Tool Schemas for Model Function Calling
export const DB_TOOLS: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "db_list_tables",
      description:
        "Lists all user tables in the connected database with row counts and types. Strictly read-only.",
      parameters: {
        type: "object",
        properties: {
          schema: {
            type: "string",
            description:
              "Schema to inspect (defaults to 'public' on Postgres, or current DB on MySQL/SQLite).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_describe_table",
      description:
        "Describes column definitions, types, nullability, primary keys, and defaults for a table.",
      parameters: {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description: "Name of the table to describe.",
          },
          schema: {
            type: "string",
            description: "Optional schema name.",
          },
        },
        required: ["table_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_schema",
      description:
        "Returns the complete schema outline of all tables and columns in the active database.",
      parameters: {
        type: "object",
        properties: {
          schema: {
            type: "string",
            description: "Optional schema name.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_query",
      description:
        "Executes a strictly read-only SQL query (SELECT, EXPLAIN, SHOW) and returns results.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Read-only SQL query to execute.",
          },
          max_rows: {
            type: "number",
            description: "Maximum rows to return (default: 50, max: 200).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_preview",
      description:
        "Previews the first N sample rows from a table. Strictly read-only.",
      parameters: {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description: "Name of the table to preview.",
          },
          limit: {
            type: "number",
            description: "Number of rows to preview (default: 5, max: 20).",
          },
          schema: {
            type: "string",
            description: "Optional schema name.",
          },
        },
        required: ["table_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_relationships",
      description:
        "Inspects foreign key relationships and table dependencies across the database.",
      parameters: {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description:
              "Optional table name to filter relationships for. Omit to list all.",
          },
          schema: {
            type: "string",
            description: "Optional schema name.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_search",
      description:
        "Searches for columns matching a keyword across all tables in the database.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "Column name or keyword to search for.",
          },
          schema: {
            type: "string",
            description: "Optional schema name.",
          },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_explain",
      description:
        "Analyzes execution plan (EXPLAIN ANALYZE) for a SELECT query to identify bottlenecks and index scans.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "SQL SELECT query to explain.",
          },
        },
        required: ["query"],
      },
    },
  },
];

const DB_TOOL_NAMES = new Set(DB_TOOLS.map((t) => t.function.name));

export function isDbTool(toolName: string): boolean {
  return DB_TOOL_NAMES.has(toolName);
}

// Native execution handler for all database tools
export async function executeDbTool(
  toolName: string,
  args: Record<string, any>,
): Promise<string> {
  try {
    const adapter = await getOrInitAdapter();

    switch (toolName) {
      case "db_list_tables": {
        const tables = await adapter.listTables(args.schema);
        if (tables.length === 0) return "No tables found in database.";
        const lines = tables.map((t) => {
          const rowInfo =
            t.approxRows !== undefined
              ? ` (~${t.approxRows.toLocaleString()} rows)`
              : "";
          const sizeInfo = t.size ? ` [${t.size}]` : "";
          return `• ${t.name} (${t.type})${rowInfo}${sizeInfo}`;
        });
        return `📊 Database Tables (${tables.length} total):\n${lines.join("\n")}`;
      }

      case "db_describe_table": {
        const table = String(args.table_name ?? "").trim();
        if (!table) return "Error: table_name is required.";
        const cols = await adapter.describeTable(table, args.schema);
        if (cols.length === 0) return `Table "${table}" not found or has no columns.`;
        const lines = cols.map((c) => {
          const pk = c.isPrimaryKey ? " 🔑 PK" : "";
          const nullInfo = c.nullable ? "NULL" : "NOT NULL";
          const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : "";
          return `• ${c.name.padEnd(20)} ${c.type.padEnd(16)} ${nullInfo}${pk}${def}`;
        });
        return `📋 Schema for Table: ${table} (${cols.length} columns)\n${lines.join("\n")}`;
      }

      case "db_schema": {
        return await adapter.getSchema(args.schema);
      }

      case "db_query": {
        const sql = String(args.query ?? "").trim();
        if (!sql) return "Error: query is required.";
        const maxRows = Math.min(Number(args.max_rows) || 50, 200);
        const rows = await adapter.readQuery(sql, maxRows);
        if (rows.length === 0) return "Query returned 0 rows.";
        return `🔍 Query returned ${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`;
      }

      case "db_preview": {
        const table = String(args.table_name ?? "").trim();
        if (!table) return "Error: table_name is required.";
        const limit = Math.min(Number(args.limit) || 5, 20);
        const rows = await adapter.previewTable(table, limit, args.schema);
        if (rows.length === 0) return `Table "${table}" is empty.`;
        return `👁️ Preview: ${table} (${rows.length} rows):\n${JSON.stringify(rows, null, 2)}`;
      }

      case "db_relationships": {
        const rels = await adapter.getRelationships(args.table_name, args.schema);
        if (rels.length === 0) {
          return args.table_name
            ? `No foreign key relationships found for table "${args.table_name}".`
            : "No foreign key relationships found in database.";
        }
        const lines = rels.map(
          (r) =>
            `• ${r.fromTable}.${r.fromColumn} ➔ ${r.toTable}.${r.toColumn}${r.constraintName ? ` (${r.constraintName})` : ""}`,
        );
        return `🔗 Foreign Key Relationships (${rels.length} total):\n${lines.join("\n")}`;
      }

      case "db_search": {
        const kw = String(args.keyword ?? "").trim();
        if (!kw) return "Error: keyword is required.";
        const results = await adapter.searchColumns(kw, args.schema);
        if (results.length === 0) return `No columns found matching "${kw}".`;
        const lines = results.map(
          (r) =>
            `• ${r.table}.${r.column} (${r.type})${r.isPrimaryKey ? " 🔑 PK" : ""}`,
        );
        return `🔎 Column Search Results for "${kw}" (${results.length} matches):\n${lines.join("\n")}`;
      }

      case "db_explain": {
        const sql = String(args.query ?? "").trim();
        if (!sql) return "Error: query is required.";
        return await adapter.explainQuery(sql);
      }

      default:
        return `Unknown database tool: ${toolName}`;
    }
  } catch (err: any) {
    return `Database Error (${toolName}): ${err.message}`;
  }
}
