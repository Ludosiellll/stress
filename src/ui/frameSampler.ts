/** Collects requestAnimationFrame timestamps for `durationMs` (the timestamps share the performance.now() time base). */
export function collectFrameTimestamps(durationMs: number): Promise<number[]> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const tick = (ts: number): void => {
      stamps.push(ts);
      const first = stamps[0] ?? ts;
      if (ts - first >= durationMs) resolve(stamps);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
