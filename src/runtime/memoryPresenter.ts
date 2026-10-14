import type { MemoryTrial } from '../modules/memory/generate';
import type { FrameClock } from './frameClock';
import type { MemoryRenderer } from './memoryRenderer';

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** The fixation cross is on screen this long from the first frame t0, ms. */
export const FIXATION_MS = 500;

/**
 * Shows one memory trial frame by frame (all times are frame timestamps, as in the reaction runner):
 * - the fixation cross from the first frame t0;
 * - sequential modes: item k at the first frame with ts ≥ t0 + 500 + k·(itemMs + gapMs) — the schedule is
 *   kept from t0, so a late frame never pushes later items back — hidden at the first frame with
 *   ts ≥ its onset + itemMs;
 * - card: at the first frame with ts ≥ t0 + 500, hidden cardMs after its onset.
 * Resolves 'done' at the frame that hides the last item, or 'aborted' (screen cleared) when `signal` aborts;
 * a renderer that throws rejects the promise with its error. Nothing is requested after the end.
 */
export function presentMemoryTrial(
  t: MemoryTrial,
  clock: FrameClock,
  r: MemoryRenderer,
  signal: AbortSignal,
): Promise<'done' | 'aborted'> {
  return new Promise((resolve, reject) => {
    let frameId: number | null = null;
    let t0: number | null = null;
    /** Onset of the item (or card) on screen; null while nothing is. */
    let shownAt: number | null = null;
    /** Index of the next item to show (the card counts as one). */
    let next = 0;
    const count = t.mode === 'card' ? 1 : t.items.length;
    const showMs = t.mode === 'card' ? t.cardMs : t.itemMs;

    const end = (): void => {
      if (frameId !== null) clock.cancel(frameId);
      frameId = null;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      end();
      try {
        r.clear();
        resolve('aborted');
      } catch (e) {
        reject(asError(e));
      }
    };
    const onFrame = (ts: number): void => {
      frameId = null;
      try {
        if (t0 === null) {
          t0 = ts;
          r.fixation();
        } else {
          if (shownAt !== null && ts >= shownAt + showMs) {
            r.clear();
            shownAt = null;
            if (next >= count) {
              end();
              resolve('done');
              return;
            }
          }
          if (shownAt === null && next < count && ts >= t0 + FIXATION_MS + next * (t.itemMs + t.gapMs)) {
            if (t.mode === 'card') r.card(t);
            else r.item(t, next);
            shownAt = ts;
            next++;
          }
        }
      } catch (e) {
        end();
        reject(asError(e));
        return;
      }
      frameId = clock.request(onFrame);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    frameId = clock.request(onFrame);
  });
}
