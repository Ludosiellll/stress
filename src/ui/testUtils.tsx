import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Repository } from '../data/repository';
import type { Platform } from '../platform';
import { createAudioOut, type AudioOut } from '../runtime/audio/audioOut';
import { AppContext } from './AppContext';

/** Renders a screen inside the app context (tests only); without `audio` there is no sound device. */
export function renderWithApp(
  ui: ReactElement,
  platform: Platform,
  repo: Repository,
  audio: AudioOut = createAudioOut(null),
): ReturnType<typeof render> {
  return render(<AppContext.Provider value={{ platform, repo, audio }}>{ui}</AppContext.Provider>);
}
