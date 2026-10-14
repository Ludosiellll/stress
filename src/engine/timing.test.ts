import { describe, expect, it } from 'vitest';
import { isDroppedFrame, measureRefresh } from './timing';

const STEP = 16.667;
function stamps(deltas: number[]): number[] {
  const out = [1000];
  let t = 1000;
  for (const d of deltas) {
    t += d;
    out.push(t);
  }
  return out;
}

describe('measureRefresh', () => {
  it('steady 60 Hz has no drops', () => {
    const r = measureRefresh(stamps(Array<number>(60).fill(STEP)));
    expect(r.hz).toBeCloseTo(60, 0);
    expect(Math.abs(r.hz - 60)).toBeLessThan(0.5);
    expect(r.intervalMs).toBeCloseTo(STEP, 6);
    expect(r.droppedRatio).toBe(0);
    expect(r.jitterMs).toBeCloseTo(0, 6);
  });

  it('one 33.3 ms delta gives droppedRatio 1/60', () => {
    const d = Array<number>(60).fill(STEP);
    d[30] = 33.3;
    const r = measureRefresh(stamps(d));
    expect(r.droppedRatio).toBeCloseTo(1 / 60, 10);
    expect(r.intervalMs).toBeCloseTo(STEP, 6);
    expect(r.jitterMs).toBeGreaterThan(0);
  });

  it('accepts exactly 10 timestamps', () => {
    expect(measureRefresh(stamps(Array<number>(9).fill(10))).hz).toBeCloseTo(100, 6);
  });

  it('throws RangeError on fewer than 10 timestamps', () => {
    expect(() => measureRefresh(stamps(Array<number>(8).fill(10)))).toThrow(RangeError);
  });

  it('throws RangeError on non-increasing timestamps', () => {
    const t = stamps(Array<number>(20).fill(10));
    const equal = [...t.slice(0, 10), t[9] ?? 0, ...t.slice(11)];
    expect(() => measureRefresh(equal)).toThrow(RangeError);
    const backwards = [...t.slice(0, 10), (t[9] ?? 0) - 1, ...t.slice(11)];
    expect(() => measureRefresh(backwards)).toThrow(RangeError);
  });
});

describe('isDroppedFrame', () => {
  it('25 ms at 16.667 nominal is not dropped', () => {
    expect(isDroppedFrame(25, 16.667)).toBe(false);
  });
  it('25.1 ms is dropped', () => {
    expect(isDroppedFrame(25.1, 16.667)).toBe(true);
  });
});
