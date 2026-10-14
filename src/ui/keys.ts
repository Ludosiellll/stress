import { useEffect, useEffectEvent } from 'react';

const CONTROLS = 'button, a, input, select, textarea, [role="radio"]';

/** The key event comes from a focused control, which handles Enter or Space itself. */
export function fromControl(e: KeyboardEvent): boolean {
  return e.target instanceof Element && e.target.closest(CONTROLS) !== null;
}

/**
 * Calls `handler` for window keydown events while `enabled`, auto-repeat excluded. The listener is attached
 * in the next task after mount, so the key event that brought this screen up (React may commit while that
 * event is still being dispatched) never reaches the new screen.
 */
export function useKeyDown(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const onKey = useEffectEvent(handler);
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: KeyboardEvent): void => {
      if (!e.repeat) onKey(e);
    };
    const timer = setTimeout(() => {
      window.addEventListener('keydown', listener);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', listener);
    };
  }, [enabled]);
}

/** Enter (main or numpad). */
export const isEnter = (e: KeyboardEvent): boolean => e.key === 'Enter';
