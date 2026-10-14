// Minimal typings for sql.js (test-only dependency; the package ships no types).
declare module 'sql.js' {
  export type SqlJsValue = number | string | Uint8Array | null;

  export interface Statement {
    bind(values?: SqlJsValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlJsValue>;
    free(): boolean;
  }

  export interface QueryExecResult {
    columns: string[];
    values: SqlJsValue[][];
  }

  export interface Database {
    run(sql: string, params?: SqlJsValue[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new () => Database;
  }

  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
