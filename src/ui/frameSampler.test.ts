import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFrameTimestamps } from './frameSampler';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('collectFrameTimestamps', () => {
  it('collects frames until the duration has passed, first frame included', async () => {
    let now = 100;
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
      now += 500;
      queueMicrotask(() => { cb(now); });
      return 1;
    });
    expect(await collectFrameTimestamps(1500)).toEqual([600, 1100, 1600, 2100]);
  });
});
