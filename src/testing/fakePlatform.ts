import { MemoryRepository } from '../data/memoryRepository';
import type { Repository } from '../data/repository';
import type { BackupStatus } from '../data/rows';
import type { Platform } from '../platform';

export interface FakePlatform extends Platform {
  repo: Repository;
  /** Every exportFile call, in order. */
  exports: { name: string; contents: string }[];
  fullscreen: boolean[];
}

export interface FakePlatformOptions {
  repo?: Repository;
  kind?: Platform['kind'];
  charging?: boolean | null;
  backup?: BackupStatus | null;
  version?: string;
}

/** Platform double for UI tests: memory repository, exports recorded instead of written. */
export function createFakePlatform(options: FakePlatformOptions = {}): FakePlatform {
  const repo = options.repo ?? new MemoryRepository();
  const exports: FakePlatform['exports'] = [];
  const fullscreen: boolean[] = [];
  return {
    kind: options.kind ?? 'web',
    repo,
    exports,
    fullscreen,
    appVersion: () => Promise.resolve(options.version ?? '9.9.9'),
    setFullscreen: (on) => {
      fullscreen.push(on);
      return Promise.resolve();
    },
    exportFile: (name, contents) => {
      exports.push({ name, contents });
      return Promise.resolve(`C:\\Downloads\\${name}`);
    },
    powerCharging: () => Promise.resolve(options.charging ?? null),
    backupStatus: () => Promise.resolve(options.backup ?? null),
    // Like the web build; tests replace it to hold or fail the backup before a restore.
    backupNow: () => Promise.resolve(null),
    openRepository: () => Promise.resolve(repo),
  };
}
