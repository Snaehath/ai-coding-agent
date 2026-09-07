import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  DatabaseAdapter,
  ConnectionTestResult,
  TableInfo,
  ColumnInfo,
  TableRelationship,
  ColumnSearchResult,
} from "../types.ts";
import { validateReadOnlyQuery } from "../safety.ts";

export class SqliteAdapter implements DatabaseAdapter {
  readonly engine = "sqlite" as const;
  readonly connectionString: string;
  private resolvedPath: string;
  private db: Database | null = null;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    // Normalize sqlite:///path or relative path
    let p = connectionString.replace(/^sqlite:\/\//i, "").trim();
    this.resolvedPath = path.isAbsolute(p) ? path.normalize(p) : path.resolve(process.cwd(), p);
  }

  private getDb(): Database {
    if (!this.db) {
      if (!fs.existsSync(this.resolvedPath)) {
        throw new Error(`SQLite database file not found at: ${this.resolvedPath}`);
      }
      this.db = new Database(this.resolvedPath, { readonly: true });
    }
    return this.db;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const start = performance.now();
    try {
      if (!fs.existsSync(this.resolvedPath)) {
        throw new Error(`File does not exist: ${this.resolvedPath}`);
      }

      const db = this.getDb();
      const verRes = db.query("SELECT sqlite_version() as ver;").get() as any;
      const latencyMs = Math.round(performance.now() - start);

      const version = `SQLite ${verRes?.ver ?? "3.x"}`;
      const database = path.basename(this.resolvedPath);
      const tables = await this.listTables();

      return {
        ok: true,
        latencyMs,
        engine: "sqlite",
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
        engine: "sqlite",
        tableCount: 0,
        error: err.message || "Failed to open SQLite database",
      };
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const db = this.getDb();
    const rows = db.query(`
      SELECT name, type 
      FROM sqlite_master 
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `).all() as any[];

    const result: TableInfo[] = [];
    for (const r of rows) {
      let approxRows: number | undefined;
      try {
        const countRes = db.query(`SELECT COUNT(*) as c FROM "${r.name}";`).get() as any;
        approxRows = countRes?.c ?? 0;
      } catch {
        approxRows = undefined;
      }
      result.push({
        name: r.name,
        type: (r.type || "table").toUpperCase(),
        approxRows,
        isExactRows: approxRows !== undefined,
      });
    }

    return result;
  }

  async describeTable(tableName: string): Promise<ColumnInfo[]> {
    const db = this.getDb();
    const cleanTable = tableName.replace(/"/g, '""');
    const cols = db.query(`PRAGMA table_info("${cleanTable}");`).all() as any[];

    if (!cols || cols.length === 0) {
      throw new Error(`Table "${tableName}" not found or has no columns.`);
    }

    return cols.map((c) => ({
      name: c.name,
      type: c.type || "TEXT",
      nullable: c.notnull === 0,
      isPrimaryKey: c.pk > 0,
      defaultValue: c.dflt_value !== null ? String(c.dflt_value) : undefined,
    }));
  }

  async getSchema(): Promise<string> {
    const tables = await this.listTables();
    if (tables.length === 0) {
      return `No user tables found in SQLite database (${path.basename(this.resolvedPath)}).`;
    }

    const output: string[] = [
      `SQLite Database Schema (${path.basename(this.resolvedPath)}):`,
    ];

    for (const t of tables) {
      try {
        const cols = await this.describeTable(t.name);
        const colStrs = cols.map((c) => `${c.name}: ${c.type}${c.isPrimaryKey ? " [PK]" : ""}`);
        output.push(`  • ${t.name} (${cols.length} cols): ${colStrs.join(", ")}`);
      } catch {
        output.push(`  • ${t.name} (${t.type})`);
      }
    }

    return output.join("\n");
  }

  async readQuery(rawSql: string, maxRows: number = 50): Promise<Record<string, any>[]> {
    const validation = validateReadOnlyQuery(rawSql);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const db = this.getDb();
    const rows = db.query(validation.cleanQuery).all() as Record<string, any>[];
    const limit = Math.min(Math.max(maxRows, 1), 200);

    return Array.isArray(rows) ? rows.slice(0, limit) : [];
  }

  async previewTable(tableName: string, limit: number = 3): Promise<Record<string, any>[]> {
    const db = this.getDb();
    const cleanTable = tableName.replace(/"/g, '""');
    const lim = Math.min(Math.max(limit, 1), 10);
    const rows = db.query(`SELECT * FROM "${cleanTable}" LIMIT ${lim};`).all() as Record<string, any>[];
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationships(tableName?: string): Promise<TableRelationship[]> {
    const db = this.getDb();
    const tables = tableName ? [{ name: tableName }] : await this.listTables();
    const results: TableRelationship[] = [];

    for (const t of tables) {
      try {
        const cleanTable = t.name.replace(/"/g, '""');
        const fks = db.query(`PRAGMA foreign_key_list("${cleanTable}");`).all() as any[];
        for (const fk of fks || []) {
          results.push({
            fromTable: t.name,
            fromColumn: fk.from,
            toTable: fk.table,
            toColumn: fk.to,
          });
        }
      } catch {
        // ignore
      }
    }

    return results;
  }

  async searchColumns(query: string): Promise<ColumnSearchResult[]> {
    const db = this.getDb();
    const tables = await this.listTables();
    const cleanQuery = query.toLowerCase().trim();
    const results: ColumnSearchResult[] = [];

    for (const t of tables) {
      try {
        const cols = await this.describeTable(t.name);
        for (const c of cols) {
          if (c.name.toLowerCase().includes(cleanQuery)) {
            results.push({
              table: t.name,
              column: c.name,
              type: c.type,
              isPrimaryKey: c.isPrimaryKey,
            });
          }
        }
      } catch {
        // ignore
      }
    }

    return results;
  }

  async explainQuery(rawSql: string): Promise<string> {
    const validation = validateReadOnlyQuery(rawSql);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const db = this.getDb();
    const rows = db.query(`EXPLAIN QUERY PLAN ${validation.cleanQuery}`).all() as any[];
    return (rows || []).map((r) => `[id:${r.id}, parent:${r.parent}] ${r.detail}`).join("\n");
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }
  }
}
