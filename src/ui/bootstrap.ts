import { rebuildCaches } from '../data/export';
import type { Repository } from '../data/repository';
import type { Platform } from '../platform';
import { installErrorLog, logEvent } from './errorLog';

async function logBackup(repo: Repository, platform: Platform): Promise<void> {
  const status = await platform.backupStatus();
  if (status === null) return;
  if (!status.ok) {
    await logEvent(repo, 'error', `Резервная копия: ${status.error ?? 'причина неизвестна'}`);
  } else {
    await logEvent(repo, 'info', `Резервная копия: ${status.path ?? 'новая копия не понадобилась'}`);
  }
}

async function start(platform: Platform): Promise<Repository> {
  const repo = await platform.openRepository();
  // Kept for the life of the window: nothing needs to remove these listeners.
  installErrorLog(repo, window);
  try {
    // Re-derives module levels and Elo ratings from history, so a cache left stale by an
    // abandoned save heals at every start (R30). A failure is logged and Home still opens.
    await rebuildCaches(repo);
  } catch (e) {
    const reason = e instanceof Error ? e : new Error(String(e));
    await logEvent(repo, 'error', `Не удалось пересчитать кэши: ${reason.message}`, reason.stack ?? '');
  }
  try {
    await logBackup(repo, platform);
  } catch (e) {
    await logEvent(repo, 'warn', `Не удалось узнать статус резервной копии: ${e instanceof Error ? e.message : String(e)}`);
  }
  return repo;
}

const started = new WeakMap<Platform, Promise<Repository>>();

/**
 * Opens the repository and runs the startup steps once per platform object, so React StrictMode's
 * second effect run (and a remount) reuses the same work. A failed start is forgotten and can be retried.
 */
export function bootstrap(platform: Platform): Promise<Repository> {
  let promise = started.get(platform);
  if (promise === undefined) {
    promise = start(platform);
    started.set(platform, promise);
    promise.catch(() => {
      started.delete(platform);
    });
  }
  return promise;
}
