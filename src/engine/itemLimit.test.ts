import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BASE_ITEM_LIMIT_MS, MIN_ITEM_LIMIT_MS, effectiveDifficulty, itemTimeLimit } from './itemLimit';

describe('item limit constants', () => {
  it('are 40 s and 8 s', () => {
    expect(BASE_ITEM_LIMIT_MS).toBe(40000);
    expect(MIN_ITEM_LIMIT_MS).toBe(8000);
  });
});

describe('effectiveDifficulty', () => {
  it('is the structural difficulty at the base limit', () => {
    expect(effectiveDifficulty(950, 40000)).toBe(950);
  });

  it('adds 200 per halving of the limit', () => {
    expect(effectiveDifficulty(950, 20000)).toBe(1150);
    expect(effectiveDifficulty(950, 8000)).toBeCloseTo(1414.386, 3);
  });

  it('rejects a limit that is not a finite positive number', () => {
    for (const limitMs of [0, -1000, Number.NaN, Infinity]) {
      expect(() => effectiveDifficulty(950, limitMs), String(limitMs)).toThrow(RangeError);
    }
  });
});

describe('itemTimeLimit', () => {
  it('keeps the base limit up to the family maximum', () => {
    expect(itemTimeLimit(900, 900, 950)).toBe(40000);
    expect(itemTimeLimit(950, 950, 950)).toBe(40000);
  });

  it('shortens the limit above the family maximum, in steps of 100 ms', () => {
    expect(itemTimeLimit(1000, 950, 950)).toBe(33600);
    expect(itemTimeLimit(960, 900, 950)).toBe(32500);
    expect(itemTimeLimit(1100, 950, 950)).toBe(23800);
    expect(itemTimeLimit(1300, 950, 950)).toBe(11900);
  });

  it('never goes below 8 s', () => {
    expect(itemTimeLimit(1500, 950, 950)).toBe(8000);
  });

  it('rejects inputs that are not finite', () => {
    expect(() => itemTimeLimit(Number.NaN, 950, 950)).toThrow(RangeError);
    expect(() => itemTimeLimit(1000, Infinity, 950)).toThrow(RangeError);
    expect(() => itemTimeLimit(1000, 950, Number.NaN)).toThrow(RangeError);
  });

  // targetD and familyMaxD are drawn around dStruct, so many runs land strictly inside (8000, 40000).
  // Integers in tenths: fc.double would crowd the offsets around 0.
  const dStruct = fc.integer({ min: 500, max: 2000 });
  const offset = fc.integer({ min: -3000, max: 8000 }).map((x) => x / 10);

  it('is a multiple of 100 in [8000, 40000]; strictly inside, it lands within 2 of targetD', () => {
    let inside = 0;
    fc.assert(
      fc.property(dStruct, offset, offset, (d, gap, slack) => {
        const targetD = d + gap;
        const limit = itemTimeLimit(targetD, d, d + slack);
        expect(limit % 100).toBe(0);
        expect(limit).toBeGreaterThanOrEqual(MIN_ITEM_LIMIT_MS);
        expect(limit).toBeLessThanOrEqual(BASE_ITEM_LIMIT_MS);
        if (limit > MIN_ITEM_LIMIT_MS && limit < BASE_ITEM_LIMIT_MS) {
          inside++;
          expect(Math.abs(effectiveDifficulty(d, limit) - targetD)).toBeLessThanOrEqual(2);
        }
      }),
      { numRuns: 1000 },
    );
    expect(inside).toBeGreaterThan(100);
  });

  it('does not grow as targetD grows', () => {
    fc.assert(
      fc.property(dStruct, offset, offset, offset, (d, a, b, slack) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(itemTimeLimit(d + hi, d, d + slack)).toBeLessThanOrEqual(itemTimeLimit(d + lo, d, d + slack));
      }),
      { numRuns: 1000 },
    );
  });
});
