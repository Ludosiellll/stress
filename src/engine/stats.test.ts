import { describe, expect, it } from 'vitest';
import { cv, mean, median, medianOfSorted, quantile, sd, sdTrimmed } from './stats';

describe('stats', () => {
  it('mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBeNaN();
  });

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it('median does not mutate input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('medianOfSorted reads the middle of an ascending array in place', () => {
    expect(medianOfSorted([1, 2, 7])).toBe(2);
    expect(medianOfSorted([1, 2, 3, 10])).toBe(2.5);
    expect(medianOfSorted([])).toBeNaN();
  });

  it('sd is the sample deviation (n-1)', () => {
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(sd([5])).toBe(0);
    expect(sd([])).toBe(0);
  });

  it('cv', () => {
    expect(cv([10, 10])).toBe(0);
    expect(cv([0, 0])).toBe(0);
    expect(cv([-1, 1])).toBe(0);
    expect(cv([8, 12])).toBeCloseTo(sd([8, 12]) / 10, 10);
  });

  it('sdTrimmed drops |z| > 3 once', () => {
    // The outlier goes: mean 381, SD 371, 2000 − 381 > 3·371; the rest has SD 0.
    expect(sdTrimmed([...Array<number>(20).fill(300), 2000])).toBe(0);
    expect(sdTrimmed([300, 310, 320])).toBe(10);
    expect(sdTrimmed([5])).toBe(0);
    expect(sdTrimmed([])).toBe(0);
  });

  it('sdTrimmed trims only once; without outliers it is the sample SD', () => {
    // Without trimming it is the plain sample SD.
    expect(sdTrimmed([1, 2, 3, 4, 100])).toBe(sd([1, 2, 3, 4, 100]));
    const xs = [...Array<number>(30).fill(300), 400, 2000];
    const m = mean(xs);
    const s = sd(xs);
    const kept = xs.filter((x) => Math.abs(x - m) <= 3 * s);
    expect(kept).toHaveLength(31);
    // 400 would be an outlier of the rest, but the trim runs once.
    expect(sdTrimmed(xs)).toBe(sd(kept));
  });

  it('quantile interpolates linearly between ranks at (k − 1)·p', () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile([10], 0.5)).toBe(10);
    // Order does not matter, the ends are the extremes, and the input is not sorted in place.
    const xs = [4, 1, 3, 2];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
    expect(quantile(xs, 0.5)).toBe(2.5);
    expect(xs).toEqual([4, 1, 3, 2]);
    expect(quantile([], 0.5)).toBeNaN();
  });
});
