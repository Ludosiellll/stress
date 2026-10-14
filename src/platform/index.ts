import type { Repository } from '../data/repository';
import type { BackupStatus } from '../data/rows';
import { createTauriPlatform } from './tauri';
import { createWebPlatform } from './web';

/** What the app needs from the host: the Tauri window or a plain browser tab (preview, e2e). */
export interface Platform {
  kind: 'tauri' | 'web';
  appVersion(): Promise<string>;
  setFullscreen(on: boolean): Promise<void>;
  /** Saves a file and returns where it went (full path in Tauri, file name in the browser). */
  exportFile(name: string, contents: string): Promise<string>;
  /** true = on mains power, false = on battery, null = the system does not tell. */
  powerCharging(): Promise<boolean | null>;
  /** Outcome of the backup made at startup; null where there is none (web). */
  backupStatus(): Promise<BackupStatus | null>;
  /**
   * Copies the database now (before a restore) and returns the path of the copy; null where there is no database
   * file (web). Rejects with an Error whose message is the reason.
   */
  backupNow(): Promise<string | null>;
  /** Called once per start: the web repository is empty each time. */
  openRepository(): Promise<Repository>;
}

export function getPlatform(): Platform {
  return '__TAURI_INTERNALS__' in window ? createTauriPlatform() : createWebPlatform();
}
