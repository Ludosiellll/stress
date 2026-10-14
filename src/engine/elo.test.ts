import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  R0,
  expectedScore,
  familyWeights,
  pickWeighted,
  targetDifficulty,
  updateRating,
} from './elo';
import { createRng } from './rng';

describe('expectedScore', () => {
  it('is 0.5 for equal rating and difficulty', () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
  });

  it('is about 0.75 at the target difficulty', () => {
    fc.assert(
      fc.property(fc.double({ min: -2000, max: 4000, noNaN: true }), (R) => {
        expect(expectedScore(R, targetDifficulty(R))).toBeCloseTo(0.75, 9);
      }),
      { numRuns: 1000 },
    );
  });

  it('grows with rating and shrinks with difficulty', () => {
    expect(expectedScore(1200, 1000)).toBeGreaterThan(expectedScore(1000, 1000));
    expect(expectedScore(1000, 1200)).toBeLessThan(expectedScore(1000, 1000));
  });
});

describe('targetDifficulty', () => {
  it('sits 400·log10(3) below the rating', () => {
    expect(targetDifficulty(1000)).toBeCloseTo(1000 - 400 * Math.log10(3), 12);
  });
});

describe('updateRating', () => {
  it('uses K = 48 below 20 attempts', () => {
    expect(updateRating({ rating: R0, n: 0 }, 1000, true)).toEqual({ rating: 1024, n: 1 });
    expect(updateRating({ rating: R0, n: 19 }, 1000, true)).toEqual({ rating: 1024, n: 20 });
  });

  it('uses K = 32 from 20 attempts on', () => {
    expect(updateRating({ rating: 1000, n: 20 }, 1000, false)).toEqual({ rating: 984, n: 21 });
  });

  it('moves up on success and down on failure', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 3000, noNaN: true }),
        fc.double({ min: 0, max: 3000, noNaN: true }),
        fc.integer({ min: 0, max: 100 }),
        (rating, D, n) => {
          expect(updateRating({ rating, n }, D, true).rating).toBeGreaterThan(rating);
          expect(updateRating({ rating, n }, D, false).rating).toBeLessThan(rating);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('familyWeights', () => {
  it('gives weaker families more weight', () => {
    expect(familyWeights([1000, 1200])).toEqual([2, 1]);
  });

  it('is all ones for equal ratings and for a single family', () => {
    expect(familyWeights([1100, 1100, 1100])).toEqual([1, 1, 1]);
    expect(familyWeights([900])).toEqual([1]);
  });

  it('returns an empty list for no families', () => {
    expect(familyWeights([])).toEqual([]);
  });

  it('is at least 1 for every family', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 3000, noNaN: true }), { minLength: 1 }), (rs) => {
        for (const w of familyWeights(rs)) expect(w).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('pickWeighted', () => {
  it('matches the weights over 10 000 picks within 3 %', () => {
    const items = ['a', 'b', 'c'];
    const weights = [1, 2, 7];
    const rng = createRng(42);
    const counts = new Map<string, number>();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const item = pickWeighted(items, weights, rng);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    const total = weights.reduce((a, b) => a + b, 0);
    items.forEach((item, i) => {
      const freq = (counts.get(item) ?? 0) / N;
      expect(Math.abs(freq - (weights[i] ?? 0) / total)).toBeLessThan(0.03);
    });
  });

  it('never picks a zero-weight item', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) expect(pickWeighted(['x', 'y', 'z'], [0, 1, 0], rng)).toBe('y');
  });

  it('consumes exactly one rng.next() per pick', () => {
    const a = createRng(5);
    const b = createRng(5);
    pickWeighted([1, 2, 3], [1, 1, 1], a);
    b.next();
    expect(a.next()).toBe(b.next());
  });

  it('falls back to the last weighted item when rounding pushes the target to the total', () => {
    const rng = { ...createRng(1), next: () => 1 };
    expect(pickWeighted(['a', 'b', 'c'], [1, 2, 0], rng)).toBe('b');
  });

  it('is deterministic per seed', () => {
    const pick = (seed: number) => pickWeighted([1, 2, 3, 4], [1, 2, 3, 4], createRng(seed));
    expect(pick(9)).toBe(pick(9));
  });

  it('throws on empty items, length mismatch, bad weights or zero sum', () => {
    const rng = createRng(1);
    expect(() => pickWeighted([], [], rng)).toThrow();
    expect(() => pickWeighted([1, 2], [1], rng)).toThrow();
    expect(() => pickWeighted([1, 2], [1, -1], rng)).toThrow();
    expect(() => pickWeighted([1, 2], [1, Number.NaN], rng)).toThrow();
    expect(() => pickWeighted([1, 2], [1, Infinity], rng)).toThrow();
    expect(() => pickWeighted([1, 2], [0, 0], rng)).toThrow();
  });
});
