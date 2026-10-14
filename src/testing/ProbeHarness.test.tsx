import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_FRAME_MS } from '../ui/frameSampler';
import { manualFrames, mockCanvas } from './domFakes';
import ProbeHarness, { PROBE_TRIALS, probeSpecs } from './ProbeHarness';

beforeEach(() => {
  manualFrames();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 61 frames 16.667 ms apart. */
const sixtyHz = (): Promise<number[]> => Promise.resolve(Array.from({ length: 61 }, (_, i) => 1000 + (i * 1000) / 60));

describe('probeSpecs', () => {
  it('is 10 red-circle Space trials, window 1000 ms, ISI 600–800 ms, the same every time', () => {
    const specs = probeSpecs();
    expect(specs).toHaveLength(PROBE_TRIALS);
    expect(PROBE_TRIALS).toBe(10);
    for (const s of specs) {
      expect(s.windowMs).toBe(1000);
      expect(Number.isInteger(s.isiMs) && s.isiMs >= 600 && s.isiMs <= 800).toBe(true);
      expect(s.stimulus).toEqual({ kind: 'shape', shape: 'circle', color: 'red' });
      expect(s.expected).toEqual({ kind: 'press', key: 'Space' });
    }
    expect(probeSpecs()).toEqual(specs);
  });
});

describe('ProbeHarness', () => {
  it('measures the frame interval, then starts the block on the button', async () => {
    mockCanvas();
    const { container } = render(<ProbeHarness measureFrames={sixtyHz} />);
    const start = await screen.findByRole('button', { name: 'Начать замер' });
    const frame = container.querySelector('[data-frame-ms]');
    expect(Number(frame?.getAttribute('data-frame-ms'))).toBeCloseTo(1000 / 60, 3);
    fireEvent.click(start);
    expect(container.querySelector('.reaction canvas')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to 60 Hz when the measurement fails', async () => {
    const { container } = render(<ProbeHarness measureFrames={() => Promise.reject(new Error('hidden'))} />);
    await screen.findByRole('button', { name: 'Начать замер' });
    expect(Number(container.querySelector('[data-frame-ms]')?.getAttribute('data-frame-ms'))).toBe(FALLBACK_FRAME_MS);
  });
});
