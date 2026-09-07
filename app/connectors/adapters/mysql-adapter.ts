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

export class MysqlAdapter implements DatabaseAdapter {
  readonly engine = "mysql" as const;
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
      const verRes: any[] = await sql.unsafe("SELECT VERSION() as ver, DATABASE() as db;");
      const latencyMs = Math.round(performance.now() - start);

      const version = verRes[0]?.ver ?? "MySQL";
      const database = verRes[0]?.db ?? "unknown";

      const tables = await this.listTables(database);

      return {
        ok: true,
        latencyMs,
        engine: "mysql",
        version: `MySQL ${version}`,
        database,
        tableCount: tables.length,
        tables,
      };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - start);
      return {
        ok: false,
        latencyMs,
        engine: "mysql",
        tableCount: 0,
        error: err.message || "Failed to connect to MySQL database",
      };
    }
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const sql = this.getSql();
    const cleanSchema = (schema || "").replace(/'/g, "''");
    const schemaFilter = cleanSchema
      ? `WHERE table_schema = '${cleanSchema}'`
      : "WHERE table_schema = DATABASE()";

    const rows: any[] = await sql.unsafe(`
      SELECT 
        table_name,
        table_type,
        table_rows as approx_rows
      FROM information_schema.tables
      ${schemaFilter}
      ORDER BY table_name;
    `);

    const result: TableInfo[] = [];
    for (const r of rows || []) {
      let count = Math.max(Number(r.approx_rows) || 0, 0);
      let isExact = false;
      if (count === 0 && r.table_type === "BASE TABLE") {
        try {
          const dbPrefix = cleanSchema ? `\`${cleanSchema}\`.` : "";
          const countRes: any[] = await sql.unsafe(
            `SELECT count(*) as c FROM ${dbPrefix}\`${r.table_name.replace(/`/g, "``")}\`;`
          );
          if (countRes && countRes[0]?.c !== undefined) {
            count = Number(countRes[0].c);
            isExact = true;
          }
        } catch {
          // ignore
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

  async describeTable(tableName: string, schema?: string): Promise<ColumnInfo[]> {
    const sql = this.getSql();
    const cleanTable = tableName.replace(/'/g, "''");
    const cleanSchema = (schema || "").replace(/'/g, "''");
    const schemaFilter = cleanSchema
      ? `AND table_schema = '${cleanSchema}'`
      : "AND table_schema = DATABASE()";

    const rows: any[] = await sql.unsafe(`
      SELECT 
        column_name,
        column_type,
        is_nullable,
        column_default,
        column_key
      FROM information_schema.columns
      WHERE table_name = '${cleanTable}' ${schemaFilter}
      ORDER BY ordinal_position;
    `);

    return (rows || []).map((r) => ({
      name: r.column_name,
      type: r.column_type,
      nullable: r.is_nullable === "YES",
      isPrimaryKey: r.column_key === "PRI",
      defaultValue: r.column_default || undefined,
    }));
  }

  async getSchema(schema?: string): Promise<string> {
    const sql = this.getSql();
    const cleanSchema = (schema || "").replace(/'/g, "''");
    const schemaFilter = cleanSchema
      ? `WHERE table_schema = '${cleanSchema}'`
      : "WHERE table_schema = DATABASE()";

    const rows: any[] = await sql.unsafe(`
      SELECT 
        table_name,
        column_name,
        column_type
      FROM information_schema.columns
      ${schemaFilter}
      ORDER BY table_name, ordinal_position;
    `);

    if (!rows || rows.length === 0) {
      return `No tables/columns found in database.`;
    }

    const tableMap = new Map<string, string[]>();
    for (const r of rows) {
      const list = tableMap.get(r.table_name) || [];
      list.push(`${r.column_name}: ${r.column_type}`);
      tableMap.set(r.table_name, list);
    }

    const output: string[] = [`MySQL Database Schema Overview:`];
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

  async previewTable(tableName: string, limit: number = 3, schema?: string): Promise<Record<string, any>[]> {
    const sql = this.getSql();
    const cleanTable = tableName.replace(/`/g, "``");
    const cleanSchema = (schema || "").replace(/`/g, "``");
    const dbPrefix = cleanSchema ? `\`${cleanSchema}\`.` : "";
    const lim = Math.min(Math.max(limit, 1), 10);

    const rows = await sql.unsafe(`SELECT * FROM ${dbPrefix}\`${cleanTable}\` LIMIT ${lim};`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationships(tableName?: string, schema?: string): Promise<TableRelationship[]> {
    const sql = this.getSql();
    const cleanSchema = (schema || "").replace(/'/g, "''");
    const schemaFilter = cleanSchema
      ? `AND table_schema = '${cleanSchema}'`
      : "AND table_schema = DATABASE()";
    const filter = tableName
      ? `AND (table_name = '${tableName.replace(/'/g, "''")}' OR referenced_table_name = '${tableName.replace(/'/g, "''")}')`
      : "";

    const rows: any[] = await sql.unsafe(`
      SELECT 
        table_name AS from_table,
        column_name AS from_column,
        referenced_table_name AS to_table,
        referenced_column_name AS to_column,
        constraint_name
      FROM information_schema.key_column_usage
      WHERE referenced_table_name IS NOT NULL
        ${schemaFilter}
        ${filter}
      ORDER BY table_name, column_name;
    `);

    return (rows || []).map((r) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
      constraintName: r.constraint_name,
    }));
  }

  async searchColumns(query: string, schema?: string): Promise<ColumnSearchResult[]> {
    const sql = this.getSql();
    const cleanSchema = (schema || "").replace(/'/g, "''");
    const cleanQuery = query.replace(/'/g, "''");
    const schemaFilter = cleanSchema
      ? `AND table_schema = '${cleanSchema}'`
      : "AND table_schema = DATABASE()";

    const rows: any[] = await sql.unsafe(`
      SELECT table_name, column_name, column_type as data_type
      FROM information_schema.columns
      WHERE column_name LIKE '%${cleanQuery}%'
        ${schemaFilter}
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
    const rows: any[] = await sql.unsafe(`EXPLAIN ${validation.cleanQuery}`);
    return JSON.stringify(rows, null, 2);
  }

  async disconnect(): Promise<void> {
    if (this.sqlInstance) {
      try {
        await this.sqlInstance.close();
      } catch {
        // ignore close error
      }
      this.sqlInstance = null;
    }
  }
}
