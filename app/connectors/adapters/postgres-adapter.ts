import { SQL } from "bun";
import type {
  DatabaseAdapter,
  ConnectionTestResult,
  TableInfo,
  ColumnInfo,
  TableRelationship,
  ColumnSearchResult,
} from "../types.ts";
import { validateReadOnlyQuery } from "../safety.ts";

export class PostgresAdapter implements DatabaseAdapter {
  readonly engine = "postgres" as const;
  readonly connectionString: string;
  private sqlInstance: any = null;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  private getSql(): any {
    if (!this.sqlInstance) {
      this.sqlInstance = new SQL(this.connectionString);
    }
    return this.sqlInstance;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now();
    try {
      const sql = this.getSql();
      const verRes: any[] = await sql.unsafe("SELECT version(), current_database() as db;");
      const latencyMs = Math.round(performance.now() - start);

      const version = verRes[0]?.version?.split(" on ")[0] ?? "PostgreSQL";
      const database = verRes[0]?.db ?? "unknown";

      const tables = await this.listTables();

      return {
        ok: true,
        latencyMs,
        engine: "postgres",
        version,
        database,
        tableCount: tables.length,
        tables,
      };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - start);
      return {
        ok: false,
        latencyMs,
        engine: "postgres",
        tableCount: 0,
        error: err.message || "Failed to connect to PostgreSQL database",
      };
    }
  }

  async listTables(schema: string = "public"): Promise<TableInfo[]> {
    const sql = this.getSql();
    let cleanSchema = (schema || "").replace(/'/g, "''").trim();
    if (["database", "db", "all", "*"].includes(cleanSchema.toLowerCase())) {
      cleanSchema = "";
    }

    const whereClause = cleanSchema
      ? `t.table_schema = '${cleanSchema}'`
      : `t.table_schema NOT IN ('pg_catalog', 'information_schema')`;

    let rows: any[] = await sql.unsafe(`
      SELECT 
        t.table_name,
        t.table_type,
        t.table_schema,
        GREATEST(
          COALESCE(s.n_live_tup, 0),
          COALESCE(c.reltuples::bigint, 0)
        ) AS approx_rows
      FROM information_schema.tables t
      LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
      LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name AND s.schemaname = t.table_schema
      WHERE ${whereClause}
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name;
    `);

    // Fallback: if specific schema returned 0 rows, check all non-system schemas
    if ((!rows || rows.length === 0) && cleanSchema && cleanSchema !== "public") {
      rows = await sql.unsafe(`
        SELECT 
          t.table_name,
          t.table_type,
          t.table_schema,
          GREATEST(
            COALESCE(s.n_live_tup, 0),
            COALESCE(c.reltuples::bigint, 0)
          ) AS approx_rows
        FROM information_schema.tables t
        LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
        LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
        LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name AND s.schemaname = t.table_schema
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name;
      `);
    }

    const result: TableInfo[] = [];
    for (const r of rows || []) {
      const tableSchema = r.table_schema || cleanSchema || "public";
      let count = Math.max(Number(r.approx_rows) || 0, 0);
      let isExact = false;

      // If catalog statistics report 0 (common for small or unanalyzed tables),
      // perform a fast COUNT(*) protected by a 500ms statement_timeout to prevent stalls on massive unindexed tables.
      if (count === 0 && r.table_type === "BASE TABLE") {
        try {
          await sql.unsafe(`SET statement_timeout = 500;`);
          const countRes: any[] = await sql.unsafe(
            `SELECT count(*) as c FROM "${tableSchema}"."${r.table_name.replace(/"/g, '""')}";`
          );
          if (countRes && countRes[0]?.c !== undefined) {
            count = Number(countRes[0].c);
            isExact = true;
          }
        } catch {
          // If query times out or fails, gracefully keep estimated 0
          isExact = false;
        } finally {
          try {
            await sql.unsafe(`RESET statement_timeout;`);
          } catch {
            // ignore
          }
        }
      }

      result.push({
        name: r.table_name,
        type: r.table_type || "BASE TABLE",
        approxRows: count,
        isExactRows: isExact,
      });
    }

    return result;
  }

  async describeTable(tableName: string, schema: string = "public"): Promise<ColumnInfo[]> {
    const sql = this.getSql();
    const cleanTable = tableName.replace(/'/g, "''");
    const cleanSchema = schema.replace(/'/g, "''");

    const rows: any[] = await sql.unsafe(`
      SELECT 
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name, ku.table_name, ku.table_schema
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku
          ON tc.constraint_name = ku.constraint_name
          AND tc.table_schema = ku.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.table_name = c.table_name 
          AND pk.table_schema = c.table_schema 
          AND pk.column_name = c.column_name
      WHERE c.table_name = '${cleanTable}' AND c.table_schema = '${cleanSchema}'
      ORDER BY c.ordinal_position;
    `);

    return (rows || []).map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      isPrimaryKey: r.is_primary_key === "YES",
      defaultValue: r.column_default || undefined,
    }));
  }

  async getSchema(schema: string = "public"): Promise<string> {
    const sql = this.getSql();
    const cleanSchema = schema.replace(/'/g, "''");

    const rows: any[] = await sql.unsafe(`
      SELECT 
        table_name,
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${cleanSchema}'
      ORDER BY table_name, ordinal_position;
    `);

    if (!rows || rows.length === 0) {
      return `No tables/columns found in schema "${schema}".`;
    }

    const tableMap = new Map<string, string[]>();
    for (const r of rows) {
      const list = tableMap.get(r.table_name) || [];
      list.push(`${r.column_name}: ${r.data_type}`);
      tableMap.set(r.table_name, list);
    }

    const output: string[] = [`PostgreSQL Database Schema (schema: "${schema}"):`];
    for (const [tbl, cols] of tableMap.entries()) {
      output.push(`  • ${tbl} (${cols.length} cols): ${cols.join(", ")}`);
    }

    return output.join("\n");
  }

  async readQuery(rawSql: string, maxRows: number = 50): Promise<Record<string, any>[]> {
    const validation = validateReadOnlyQuery(rawSql);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const sql = this.getSql();
    const rows: any[] = await sql.unsafe(validation.cleanQuery);
    const limit = Math.min(Math.max(maxRows, 1), 200);

    return Array.isArray(rows) ? rows.slice(0, limit) : [];
  }

  async previewTable(tableName: string, limit: number = 3, schema: string = "public"): Promise<Record<string, any>[]> {
    const sql = this.getSql();
    const cleanTable = tableName.replace(/'/g, "''");
    const cleanSchema = schema.replace(/'/g, "''");
    const lim = Math.min(Math.max(limit, 1), 10);

    const rows = await sql.unsafe(`SELECT * FROM "${cleanSchema}"."${cleanTable}" LIMIT ${lim};`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationships(tableName?: string, schema: string = "public"): Promise<TableRelationship[]> {
    const sql = this.getSql();
    const cleanSchema = schema.replace(/'/g, "''");
    const filter = tableName
      ? `AND (tc.table_name = '${tableName.replace(/'/g, "''")}' OR ccu.table_name = '${tableName.replace(/'/g, "''")}')`
      : "";

    const rows: any[] = await sql.unsafe(`
      SELECT
        tc.table_name AS from_table,
        kcu.column_name AS from_column,
        ccu.table_name AS to_table,
        ccu.column_name AS to_column,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = '${cleanSchema}'
        ${filter}
      ORDER BY tc.table_name, kcu.column_name;
    `);

    return (rows || []).map((r) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
      constraintName: r.constraint_name,
    }));
  }

  async searchColumns(query: string, schema: string = "public"): Promise<ColumnSearchResult[]> {
    const sql = this.getSql();
    const cleanSchema = schema.replace(/'/g, "''");
    const cleanQuery = query.replace(/'/g, "''");

    const rows: any[] = await sql.unsafe(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${cleanSchema}'
        AND column_name ILIKE '%${cleanQuery}%'
      ORDER BY table_name, ordinal_position;
    `);

    return (rows || []).map((r) => ({
      table: r.table_name,
      column: r.column_name,
      type: r.data_type,
    }));
  }

  async explainQuery(rawSql: string): Promise<string> {
    const validation = validateReadOnlyQuery(rawSql);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const sql = this.getSql();
    const rows: any[] = await sql.unsafe(`EXPLAIN (FORMAT TEXT) ${validation.cleanQuery}`);
    return (rows || []).map((r) => r["QUERY PLAN"] || Object.values(r)[0]).join("\n");
  }

  async disconnect(): Promise<void> {
    if (this.sqlInstance) {
      try {
        await this.sqlInstance.close();
      } catch {
        // ignore close errors
      }
      this.sqlInstance = null;
    }
  }
}
