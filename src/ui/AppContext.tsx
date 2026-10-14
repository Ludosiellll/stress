import { createContext, useContext } from 'react';
import type { Repository } from '../data/repository';
import type { Platform } from '../platform';

export interface AppServices {
  platform: Platform;
  repo: Repository;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp вызван вне AppContext');
  return value;
}
