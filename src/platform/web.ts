import { MemoryRepository } from '../data/memoryRepository';
import type { Platform } from '.';
import { batteryCharging } from './battery';

/** Browser host. Data lives in memory, so every page load starts empty (also with ?e2e=1). */
export function createWebPlatform(): Platform {
  return {
    kind: 'web',
    appVersion: () => Promise.resolve(__APP_VERSION__),
    setFullscreen: () => Promise.resolve(),
    exportFile: (name, contents) => {
      const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      return Promise.resolve(name);
    },
    powerCharging: batteryCharging,
    backupStatus: () => Promise.resolve(null),
    openRepository: () => Promise.resolve(new MemoryRepository()),
  };
}
