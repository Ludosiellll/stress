import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Database from '@tauri-apps/plugin-sql';
import { SqliteRepository } from '../data/sqliteRepository';
import type { BackupStatus } from '../data/rows';
import { collectStatements, type SqlExecutor, type SqlValue } from '../data/sqlExecutor';
import type { Platform } from '.';
import { batteryCharging } from './battery';

/** Must be the same string for Database.load and db_batch: the plugin keys its pools by it. */
export const DB_URL = 'sqlite:trainer.db';

type PluginDatabase = Pick<Database, 'execute' | 'select'>;

/** SqlExecutor over tauri-plugin-sql, as documented in src/data/sqlExecutor.ts. */
export function createTauriExecutor(db: PluginDatabase): SqlExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
      await db.execute(sql, [...params]);
    },
    select<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      return db.select<T[]>(sql, [...params]);
    },
    async transaction(fn: (tx: SqlExecutor) => Promise<void>): Promise<void> {
      const statements = await collectStatements(fn);
      await invoke('db_batch', { db: DB_URL, statements });
    },
  };
}

export function backupStatus(): Promise<BackupStatus | null> {
  return invoke<BackupStatus>('backup_status');
}

export function createTauriPlatform(): Platform {
  return {
    kind: 'tauri',
    appVersion: () => getVersion(),
    setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
    exportFile: (name, contents) => invoke<string>('export_file', { name, contents }),
    powerCharging: batteryCharging,
    backupStatus,
    openRepository: async () => new SqliteRepository(createTauriExecutor(await Database.load(DB_URL))),
  };
}
