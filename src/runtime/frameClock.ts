/** Source of display frames. `request` calls `cb` once, at the next frame, with that frame's timestamp (ms). */
export interface FrameClock {
  request(cb: (ts: number) => void): number;
  cancel(id: number): void;
}

/** Frames from `requestAnimationFrame`; timestamps share the `performance.now()` / `event.timeStamp` time base. */
export const browserFrameClock: FrameClock = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => {
    cancelAnimationFrame(id);
  },
};
