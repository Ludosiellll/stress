import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Repository } from '../data/repository';
import type { Platform } from '../platform';
import { AppContext } from './AppContext';

/** Renders a screen inside the app context (tests only). */
export function renderWithApp(ui: ReactElement, platform: Platform, repo: Repository): ReturnType<typeof render> {
  return render(<AppContext.Provider value={{ platform, repo }}>{ui}</AppContext.Provider>);
}
