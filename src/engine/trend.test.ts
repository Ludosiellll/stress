import { describe, expect, it } from 'vitest';
import { noiseSigma, trend, trendWindow, TREND_MIN_POINTS, TREND_POINTS, type Trend } from './trend';

const pts = (ys: number[]) => ys.map((y, i) => ({ t: 7 * i, y }));

describe('noise band and trend (F7, Р19)', () => {
  it('σ̂ from successive differences', () => {
    expect(noiseSigma([1, 2, 3])).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('a falling RT beyond 2σ̂ is better', () => {
    const t = trend(pts([300, 298, 295, 292, 290, 288]), true) as Trend;
    expect(t.slope).toBeCloseTo(-304.5 / 857.5, 9);
    expect(t.change).toBeCloseTo((-304.5 / 857.5) * 35, 9);
    expect(t.sigma).toBeCloseTo(Math.sqrt(3), 9);
    expect(t).toMatchObject({ days: 35, verdict: 'better' });
  });

  it('a zigzag within 2σ̂ is noise; only the last 6 points count; fewer than 3 give none', () => {
    expect(trend(pts([300, 310, 300, 310, 300, 310]), true)?.verdict).toBe('noise');
    expect(trend(pts([999, 300, 298, 295, 292, 290, 288]), true)?.days).toBe(35);
    expect(trend(pts([300, 290]), true)).toBeNull();
  });

  it('σ̂ of fewer than two values is 0', () => {
    expect(noiseSigma([])).toBe(0);
    expect(noiseSigma([5])).toBe(0);
  });

  it('the direction of the metric decides better or worse; the line passes through the means', () => {
    const rising = pts([300, 302, 305, 308, 310, 312]);
    expect(trend(rising, true)?.verdict).toBe('worse');
    expect(trend(rising, false)?.verdict).toBe('better');
    expect(trend(pts([300, 298, 295, 292, 290, 288]), false)?.verdict).toBe('worse');
    const t = trend(rising, true) as Trend;
    // ȳ = ā + b·t̄ at t̄ = 17,5.
    expect(t.intercept + t.slope * 17.5).toBeCloseTo((300 + 302 + 305 + 308 + 310 + 312) / 6, 9);
  });

  it('points come in any order: the last ones by t count, and σ̂ follows the date order', () => {
    const shuffled = [{ t: 35, y: 288 }, { t: 0, y: 300 }, { t: 21, y: 292 }, { t: 7, y: 298 }, { t: 28, y: 290 }, { t: 14, y: 295 }, { t: -7, y: 999 }];
    expect(trend(shuffled, true)).toEqual(trend(pts([300, 298, 295, 292, 290, 288]), true));
    expect(trendWindow(shuffled).map((p) => p.t)).toEqual([0, 7, 14, 21, 28, 35]);
    expect(TREND_POINTS).toBe(6);
    expect(TREND_MIN_POINTS).toBe(3);
  });

  it('a constant series has no slope, even when the mean is not exact in floating point (T-R56)', () => {
    // Go/No-Go 91,666…% on three diagnostics: the least-squares sum alone gives a change of −4,9e-27, «хуже».
    const y = (55 / 60) * 100;
    const t = trend([20640, 20650, 20661].map((day) => ({ t: day, y })), false) as Trend;
    expect(t).toMatchObject({ slope: 0, change: 0, sigma: 0, days: 21, verdict: 'noise' });
    expect(t.intercept).toBe(y);
  });

  it('points all on one day have no slope: the change is 0, within the noise', () => {
    expect(trend([{ t: 3, y: 10 }, { t: 3, y: 12 }, { t: 3, y: 11 }], true)).toMatchObject({ slope: 0, change: 0, days: 0, verdict: 'noise' });
  });
});
