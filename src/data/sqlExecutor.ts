/**
 * Minimal SQL access that SqliteRepository needs. Placeholders are `?`; values are
 * strings, numbers or null (booleans are stored as 0/1, JSON as text by the caller).
 *
 * Transactions. The function passed to `transaction` may only call `tx.execute`:
 * its statements are collected first and then run as one unit. `tx.select` and a nested
 * `tx.transaction` reject, so read what you need before the transaction starts.
 *
 * Why collecting: tauri-plugin-sql 2.5.0 runs every `execute` on an sqlx `Pool<Sqlite>`
 * (`pool.execute(query)`, wrapper.rs:176; default pool size 10, sqlx-core pool/options.rs:151),
 * so `BEGIN`, the inserts and `COMMIT` sent as separate `execute` calls may land on different
 * connections. That is not a transaction and can leave one open on a pooled connection.
 *
 * Contract for the Tauri executor (src/platform/tauri.ts, Task 14), over `Database.load('sqlite:trainer.db')`:
 * - `execute(sql, params)` → `db.execute(sql, params)`;
 * - `select(sql, params)` → `db.select(sql, params)` (rows keyed by column name; INTEGER/REAL → number, TEXT → string);
 * - `transaction(fn)` → `const statements = await collectStatements(fn)`, then
 *   `invoke('db_batch', { db: 'sqlite:trainer.db', statements })`. The Rust command
 *   (src-tauri/src/commands.rs) runs them inside one sqlx transaction on the plugin's own pool
 *   and rolls everything back on the first error. An empty list is a no-op.
 * The `db` string must be exactly the one passed to `Database.load` (the plugin keys its pools by it).
 */

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params: SqlValue[];
}

export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<void>;
  select<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  transaction(fn: (tx: SqlExecutor) => Promise<void>): Promise<void>;
}

/** Runs `fn` against a recorder and returns the statements it executed, in order. */
export async function collectStatements(fn: (tx: SqlExecutor) => Promise<void>): Promise<SqlStatement[]> {
  const statements: SqlStatement[] = [];
  const recorder: SqlExecutor = {
    execute(sql, params = []) {
      statements.push({ sql, params: [...params] });
      return Promise.resolve();
    },
    select() {
      return Promise.reject(new Error('select is not allowed inside a transaction'));
    },
    transaction() {
      return Promise.reject(new Error('nested transactions are not supported'));
    },
  };
  await fn(recorder);
  return statements;
}
