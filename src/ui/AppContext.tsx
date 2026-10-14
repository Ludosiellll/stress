import { createContext, useContext } from 'react';
import type { Repository } from '../data/repository';
import type { Platform } from '../platform';
import type { AudioOut } from '../runtime/audio/audioOut';

export interface AppServices {
  platform: Platform;
  repo: Repository;
  /** Sound stressors; reaction blocks and «Проверить звук» play through it. */
  audio: AudioOut;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp вызван вне AppContext');
  return value;
}
