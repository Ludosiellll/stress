// Test-only SqlExecutor over sql.js (in-memory SQLite compiled to WebAssembly).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { collectStatements, type SqlExecutor, type SqlValue } from '../data/sqlExecutor';

const distDir = dirname(createRequire(import.meta.url).resolve('sql.js'));

/** Fresh in-memory database with foreign keys on, as sqlx opens SQLite connections. */
export async function openSqlJs(): Promise<Database> {
  const SQL = await initSqlJs({ locateFile: (f) => join(distDir, f) });
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Same contract as the Tauri executor: a transaction collects its statements first
 * (select inside it rejects), then runs them between BEGIN and COMMIT, or ROLLBACK on error.
 */
export function sqlJsExecutor(db: Database): SqlExecutor {
  return {
    execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
      try {
        db.run(sql, [...params]);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    select<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      try {
        const stmt = db.prepare(sql);
        try {
          stmt.bind([...params]);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return Promise.resolve(rows);
        } finally {
          stmt.free();
        }
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async transaction(fn: (tx: SqlExecutor) => Promise<void>): Promise<void> {
      const statements = await collectStatements(fn);
      db.run('BEGIN');
      try {
        for (const s of statements) db.run(s.sql, [...s.params]);
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
  };
}
