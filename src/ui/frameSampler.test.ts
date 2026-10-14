import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFrameTimestamps } from './frameSampler';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** rAF double: frames are delivered by hand with `step`. */
function manualFrames() {
  let pending: ((ts: number) => void) | null = null;
  let nextId = 0;
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
    pending = cb;
    return ++nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    cancel,
    hasPending: () => pending !== null,
    step(ts: number) {
      const cb = pending;
      pending = null;
      cb?.(ts);
    },
  };
}

function setHidden(hidden: boolean): void {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('collectFrameTimestamps', () => {
  it('collects frames until the duration has passed, first frame included', async () => {
    const frames = manualFrames();
    const result = collectFrameTimestamps(1500);
    for (const ts of [600, 1100, 1600, 2100]) frames.step(ts);
    expect(await result).toEqual([600, 1100, 1600, 2100]);
    expect(frames.hasPending()).toBe(false);
  });

  it('rejects and cancels the pending frame when aborted', async () => {
    const frames = manualFrames();
    const controller = new AbortController();
    const result = collectFrameTimestamps(3000, controller.signal);
    frames.step(10);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(frames.cancel).toHaveBeenCalled();
  });

  it('rejects at once when the signal is already aborted', async () => {
    manualFrames();
    const controller = new AbortController();
    controller.abort();
    await expect(collectFrameTimestamps(3000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when the window is hidden during the measurement', async () => {
    const frames = manualFrames();
    const result = collectFrameTimestamps(3000);
    frames.step(10);
    setHidden(true);
    await expect(result).rejects.toThrow('скрыто');
    expect(frames.cancel).toHaveBeenCalled();
  });

  it('rejects when the window is hidden from the start', async () => {
    manualFrames();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await expect(collectFrameTimestamps(3000)).rejects.toThrow('скрыто');
  });

  it('ignores a visibility change to visible', async () => {
    const frames = manualFrames();
    const result = collectFrameTimestamps(100);
    setHidden(false);
    frames.step(0);
    frames.step(200);
    expect(await result).toEqual([0, 200]);
  });
});
