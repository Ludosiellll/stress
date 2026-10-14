/**
 * Calls `onLost` (at most once) when the window loses focus or the page becomes hidden — a block played without
 * focus has no valid timings. If the page is already hidden or unfocused at attach time, `onLost` is called
 * synchronously before this returns (ruling R17). The `blur` listener is on the window in the bubble phase, so focus
 * moving between elements inside the page (their `blur` does not bubble) does not count. Returns a function that
 * removes the listeners.
 */
export function attachFocusGuard(target: Window, doc: Document, onLost: () => void): () => void {
  let fired = false;
  const lose = (): void => {
    if (fired) return;
    fired = true;
    onLost();
  };
  const onBlur = (): void => {
    lose();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') lose();
  };
  target.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.visibilityState === 'hidden' || !doc.hasFocus()) lose();
  return () => {
    target.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
