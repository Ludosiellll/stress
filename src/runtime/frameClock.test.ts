import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserFrameClock } from './frameClock';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserFrameClock', () => {
  it('delegates to requestAnimationFrame and cancelAnimationFrame', () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(123.5);
      return 7;
    });
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    const seen: number[] = [];
    const id = browserFrameClock.request((ts) => seen.push(ts));
    browserFrameClock.cancel(id);
    expect(id).toBe(7);
    expect(seen).toEqual([123.5]);
    expect(caf).toHaveBeenCalledWith(7);
  });
});
