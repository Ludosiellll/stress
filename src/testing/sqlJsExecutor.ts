// Test-only SqlExecutor over sql.js (in-memory SQLite compiled to WebAssembly).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database } from 'sql.js';
import { collectStatements, type SqlExecutor, type SqlValue } from '../data/sqlExecutor';

const distDir = dirname(createRequire(import.meta.url).resolve('sql.js'));
const migrationsDir = fileURLToPath(new URL('../../src-tauri/migrations/', import.meta.url));
/** `0002_logic_item_time_limit.sql` → version 2, as src-tauri/src/lib.rs numbers them. */
const MIGRATION_FILE = /^(\d+)_.+\.sql$/;

/**
 * Runs the files of src-tauri/migrations in name order, up to version `upTo`, skipping the versions the
 * database already has: like sqlx's `_sqlx_migrations`, but recorded in `PRAGMA user_version`.
 * `applyMigrations(db, 1)` gives a 0.1.0 database; a later `applyMigrations(db)` upgrades it.
 */
export function applyMigrations(db: Database, upTo = Number.POSITIVE_INFINITY): void {
  const applied = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
  for (const file of readdirSync(migrationsDir).sort()) {
    const version = Number(MIGRATION_FILE.exec(file)?.[1]);
    if (!Number.isInteger(version) || version <= applied || version > upTo) continue;
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    db.exec(`PRAGMA user_version = ${String(version)}`);
  }
}

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
