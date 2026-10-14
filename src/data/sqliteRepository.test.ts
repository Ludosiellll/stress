import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openSqlJs, sqlJsExecutor } from '../testing/sqlJsExecutor';
import { repositoryContract, block, session, trial, item } from './repository.contract';
import { SqliteRepository } from './sqliteRepository';

const MIGRATION = readFileSync(new URL('../../src-tauri/migrations/0001_init.sql', import.meta.url), 'utf8');

async function fresh() {
  const db = await openSqlJs();
  db.exec(MIGRATION);
  const exec = sqlJsExecutor(db);
  return { db, exec, repo: new SqliteRepository(exec) };
}

describe('SqliteRepository (sql.js)', () => {
  repositoryContract(async () => (await fresh()).repo);

  it('the migration creates the tables and indexes', async () => {
    const { exec } = await fresh();
    const rows = await exec.select<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    );
    expect(rows).toEqual([
      { type: 'index', name: 'idx_blocks_session' },
      { type: 'index', name: 'idx_logic_items_block' },
      { type: 'index', name: 'idx_trials_block' },
      { type: 'table', name: 'app_log' },
      { type: 'table', name: 'blocks' },
      { type: 'table', name: 'diagnostics' },
      { type: 'table', name: 'logic_items' },
      { type: 'table', name: 'module_state' },
      { type: 'table', name: 'ratings' },
      { type: 'table', name: 'sessions' },
      { type: 'table', name: 'settings' },
      { type: 'table', name: 'trials' },
      { type: 'table', name: 'wellbeing' },
    ]);
  });

  it('stores flags as JSON text, booleans as 0/1 and settings as JSON values', async () => {
    const { exec, repo } = await fresh();
    await repo.createSession(session('s1', '2026-10-01T08:00:00.000Z'));
    await repo.addBlock(
      block('b1', 's1', '2026-10-01T08:01:00.000Z', { flags: ['fatigued', 'calibration'] }),
      [trial('t1', 'b1', 0, { frameDropped: true })],
      [item('i1', 'b1', '2026-10-01T08:01:00.000Z', { correct: false })],
    );
    await repo.saveSettings({ layout: 'mouse', testDate: null });
    expect(await exec.select('SELECT flags_json FROM blocks')).toEqual([{ flags_json: '["fatigued","calibration"]' }]);
    expect(await exec.select('SELECT frame_dropped FROM trials')).toEqual([{ frame_dropped: 1 }]);
    expect(await exec.select('SELECT correct FROM logic_items')).toEqual([{ correct: 0 }]);
    expect(await exec.select('SELECT key, value FROM settings ORDER BY key')).toEqual([
      { key: 'layout', value: '"mouse"' },
      { key: 'testDate', value: 'null' },
    ]);
  });

  it('enforces foreign keys from the migration', async () => {
    const { exec } = await fresh();
    await expect(
      exec.execute(
        "INSERT INTO diagnostics (id, session_id, number, at, results_json) VALUES ('d', 'ghost', 1, 'x', '{}')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('sqlJsExecutor transactions', () => {
  it('commits all statements together', async () => {
    const { exec } = await fresh();
    await exec.transaction(async (tx) => {
      await tx.execute("INSERT INTO settings (key, value) VALUES ('a', '1')");
      await tx.execute('INSERT INTO settings (key, value) VALUES (?, ?)', ['b', '2']);
    });
    expect(await exec.select('SELECT key FROM settings ORDER BY key')).toEqual([{ key: 'a' }, { key: 'b' }]);
  });

  it('rolls back every statement when one fails', async () => {
    const { exec } = await fresh();
    await expect(
      exec.transaction(async (tx) => {
        await tx.execute("INSERT INTO settings (key, value) VALUES ('a', '1')");
        await tx.execute("INSERT INTO settings (key, value) VALUES ('a', '2')");
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(await exec.select('SELECT key FROM settings')).toEqual([]);
    // The connection is usable afterwards (no transaction left open).
    await exec.execute("INSERT INTO settings (key, value) VALUES ('c', '3')");
    expect(await exec.select('SELECT key FROM settings')).toEqual([{ key: 'c' }]);
  });

  it('rejects a select inside a transaction and runs nothing', async () => {
    const { exec } = await fresh();
    await expect(
      exec.transaction(async (tx) => {
        await tx.execute("INSERT INTO settings (key, value) VALUES ('a', '1')");
        await tx.select('SELECT 1');
      }),
    ).rejects.toThrow(/select/);
    expect(await exec.select('SELECT key FROM settings')).toEqual([]);
  });

  it('rejects a nested transaction', async () => {
    const { exec } = await fresh();
    await expect(exec.transaction((tx) => tx.transaction(() => Promise.resolve()))).rejects.toThrow(/nested/);
  });

  it('rejects a failing statement or query outside a transaction', async () => {
    const { exec } = await fresh();
    await expect(exec.execute('INSERT INTO nope VALUES (1)')).rejects.toThrow();
    await expect(exec.select('SELECT * FROM nope')).rejects.toThrow();
  });
});
