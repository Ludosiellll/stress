import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fitPredictions, isUnique } from './check';

const set = (...xs: number[]): Set<number> => new Set(xs);

describe('fitPredictions (brief examples)', () => {
  it('[2,4,6,8,10] → arith {12}', () => {
    expect(fitPredictions([2, 4, 6, 8, 10]).get('arith')).toEqual(set(12));
  });

  it('[3,6,12,24,48] → geom {96}, no arith', () => {
    const p = fitPredictions([3, 6, 12, 24, 48]);
    expect(p.get('geom')).toEqual(set(96));
    expect(p.has('arith')).toBe(false);
  });

  it('[1,2,4,7,11,16] → second {22}', () => {
    expect(fitPredictions([1, 2, 4, 7, 11, 16]).get('second')).toEqual(set(22));
  });

  it('[1,1,2,3,5,8] → fib contains 13', () => {
    expect(fitPredictions([1, 1, 2, 3, 5, 8]).get('fib')?.has(13)).toBe(true);
  });

  it('[2,5,11,23,47] → linrec {95}', () => {
    expect(fitPredictions([2, 5, 11, 23, 47]).get('linrec')).toEqual(set(95));
  });

  it('[1,4,9,16,25] → powers {36} and second {36}; unique with answer 36', () => {
    const p = fitPredictions([1, 4, 9, 16, 25]);
    expect(p.get('powers')).toEqual(set(36));
    expect(p.get('second')).toEqual(set(36));
    expect(isUnique([1, 4, 9, 16, 25], 36)).toBe(true);
  });

  it('[1,2,4,8,16] → geom, linrec and fib (k=2) all predict 32; unique', () => {
    const p = fitPredictions([1, 2, 4, 8, 16]);
    expect(p.get('geom')).toEqual(set(32));
    expect(p.get('linrec')).toEqual(set(32));
    expect(p.get('fib')).toEqual(set(32));
    expect(isUnique([1, 2, 4, 8, 16], 32)).toBe(true);
  });

  it('[1,2,4,7] → second {11} conflicts with fib (k=1, c=1) {12}; not unique', () => {
    const p = fitPredictions([1, 2, 4, 7]);
    expect(p.get('second')).toEqual(set(11));
    expect(p.get('fib')).toEqual(set(12));
    expect(isUnique([1, 2, 4, 7], 11)).toBe(false);
    expect(isUnique([1, 2, 4, 7], 12)).toBe(false);
  });

  it('[1,2,4] → no arith or second predictions, geom {8}', () => {
    const p = fitPredictions([1, 2, 4]);
    expect(p.has('arith')).toBe(false);
    expect(p.has('second')).toBe(false);
    expect(p.get('geom')).toEqual(set(8));
  });
});

describe('fitPredictions', () => {
  it('lists only the families that predict something', () => {
    expect([...fitPredictions([1, 4, 9, 16, 25]).keys()]).toEqual(['second', 'powers']);
    expect(fitPredictions([]).size).toBe(0);
    expect(fitPredictions([5, 1, 7, 2]).size).toBe(0);
  });

  it('rejects terms that are not safe integers', () => {
    expect(() => fitPredictions([1, 2, 3.5])).toThrow(RangeError);
    expect(() => fitPredictions([1, Number.NaN, 3])).toThrow(RangeError);
    expect(() => fitPredictions([1, 2, 2 ** 53])).toThrow(RangeError);
  });
});

describe('isUnique', () => {
  it('needs the single prediction to equal the answer', () => {
    expect(isUnique([2, 4, 6, 8, 10], 12)).toBe(true);
    expect(isUnique([2, 4, 6, 8, 10], 11)).toBe(false);
  });

  it('is false when no family fits', () => {
    expect(isUnique([5, 1, 7, 2], 3)).toBe(false);
    expect(isUnique([], 0)).toBe(false);
  });

  it('is false when one family alone justifies two answers', () => {
    // fib: k=1 → 14, k=2 → 17.
    expect(isUnique([2, 2, 5, 8], 14)).toBe(false);
  });

  it('never throws on random integer arrays and predicts only integers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 5, maxLength: 7 }),
        fc.integer({ min: -50, max: 50 }),
        (terms, answer) => {
          expect(() => isUnique(terms, answer)).not.toThrow();
          for (const predictions of fitPredictions(terms).values()) {
            expect(predictions.size).toBeGreaterThan(0);
            for (const x of predictions) expect(Number.isInteger(x)).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('accepts exactly the one predicted value when unique', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 5, maxLength: 7 }), (terms) => {
        const all = new Set([...fitPredictions(terms).values()].flatMap((s) => [...s]));
        const unique = [...all].filter((x) => isUnique(terms, x));
        expect(unique).toEqual(all.size === 1 ? [...all] : []);
      }),
      { numRuns: 1000 },
    );
  });
});
