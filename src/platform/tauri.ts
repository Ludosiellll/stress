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

/** Known reasons a backup_now fails for, said in Russian (the command's own text is often sqlx's or the OS's English). */
const BACKUP_REASONS: readonly (readonly [RegExp, string])[] = [
  [/is not loaded/, 'база не открыта — перезапусти приложение'],
  [/database is locked|database table is locked|\bbusy\b/i, 'база занята, попробуй ещё раз через минуту'],
  [/нет файла базы данных|\(os error 2\)|NotFound|No such file or directory|cannot find the (file|path) specified/i, 'файл базы не найден'],
];

/** The Russian text of a known backup failure; null for any other reason (shown as it is). */
export function backupReason(text: string): string | null {
  return BACKUP_REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * The backup_now command; its Err arrives as a plain string, which becomes the message of an Error — in Russian
 * for a known reason (backupReason), unchanged otherwise.
 */
export async function backupNow(): Promise<string> {
  try {
    return await invoke<string>('backup_now');
  } catch (e) {
    const known = backupReason(e instanceof Error ? e.message : String(e));
    if (known !== null) throw new Error(known, { cause: e });
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export function createTauriPlatform(): Platform {
  return {
    kind: 'tauri',
    appVersion: () => getVersion(),
    setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
    exportFile: (name, contents) => invoke<string>('export_file', { name, contents }),
    powerCharging: batteryCharging,
    backupStatus,
    backupNow,
    openRepository: async () => new SqliteRepository(createTauriExecutor(await Database.load(DB_URL))),
  };
}
