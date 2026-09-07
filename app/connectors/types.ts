// Universal Database Connector Types

export type DatabaseEngine = "postgres" | "mysql" | "sqlite";

export interface TableInfo {
  name: string;
  type: string;
  approxRows?: number;
  isExactRows?: boolean; // true if COUNT(*) verified, false if catalog statistic
  size?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  engine: DatabaseEngine;
  version?: string;
  database?: string;
  tableCount: number;
  tables?: TableInfo[];
  error?: string;
}

export interface TableRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName?: string;
}

export interface ColumnSearchResult {
  table: string;
  column: string;
  type: string;
}

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  readonly connectionString: string;
  testConnection(): Promise<ConnectionTestResult>;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(tableName: string, schema?: string): Promise<ColumnInfo[]>;
  getSchema(schema?: string): Promise<string>;
  readQuery(sql: string, maxRows?: number): Promise<Record<string, any>[]>;
  previewTable(tableName: string, limit?: number, schema?: string): Promise<Record<string, any>[]>;
  getRelationships(tableName?: string, schema?: string): Promise<TableRelationship[]>;
  searchColumns(query: string, schema?: string): Promise<ColumnSearchResult[]>;
  explainQuery(sql: string): Promise<string>;
  disconnect(): Promise<void>;
}

export interface SavedConnectionsConfig {
  active?: string;
  connections: Record<string, {
    url: string;
    engine?: DatabaseEngine;
    description?: string;
    addedAt?: string;
  }>;
}
