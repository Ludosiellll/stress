/**
 * Collects requestAnimationFrame timestamps for `durationMs` (the timestamps share the performance.now() time base).
 * Rejects, and stops asking for frames, when `signal` is aborted or the window gets hidden: a hidden window
 * produces no frames or one huge gap, and such a measurement means nothing.
 */
export function collectFrameTimestamps(durationMs: number, signal?: AbortSignal): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Замер отменён', 'AbortError'));
      return;
    }
    if (document.hidden) {
      reject(new Error('окно скрыто'));
      return;
    }
    const stamps: number[] = [];
    let frameId = 0;
    const finish = (settle: () => void): void => {
      cancelAnimationFrame(frameId);
      document.removeEventListener('visibilitychange', onVisibility);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onVisibility = (): void => {
      if (document.hidden) finish(() => { reject(new Error('окно было скрыто во время замера')); });
    };
    const onAbort = (): void => {
      finish(() => { reject(new DOMException('Замер отменён', 'AbortError')); });
    };
    const tick = (ts: number): void => {
      stamps.push(ts);
      const first = stamps[0] ?? ts;
      if (ts - first >= durationMs) finish(() => { resolve(stamps); });
      else frameId = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVisibility);
    signal?.addEventListener('abort', onAbort);
    frameId = requestAnimationFrame(tick);
  });
}
