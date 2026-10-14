import { describe, expect, it } from 'vitest';
import { cv, mean, median, sd } from './stats';

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
});
