import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BASE_ITEM_LIMIT_MS,
  ITEM_LIMIT_START_MS,
  MIN_ITEM_LIMIT_MS,
  effectiveDifficulty,
  itemEffectiveDifficulty,
  itemLimitMs,
  itemTimeLimit,
  structTarget,
} from './itemLimit';

describe('item limit constants', () => {
  it('D_eff refers to 40 s; a training item starts at 30 s and never goes below 8 s', () => {
    expect(BASE_ITEM_LIMIT_MS).toBe(40000);
    expect(ITEM_LIMIT_START_MS).toBe(30000);
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

describe('stored items (R36)', () => {
  it('an item keeps its own limit; a row stored before 0.2.0 had 40 s', () => {
    expect(itemLimitMs({ timeLimitMs: 11_900 })).toBe(11_900);
    expect(itemLimitMs({ timeLimitMs: null })).toBe(BASE_ITEM_LIMIT_MS);
  });

  it('the effective difficulty comes from the stored limit, 40 s without one', () => {
    expect(itemEffectiveDifficulty({ difficulty: 950, timeLimitMs: 11_900 })).toBe(effectiveDifficulty(950, 11_900));
    expect(itemEffectiveDifficulty({ difficulty: 950, timeLimitMs: 20_000 })).toBe(1150);
    expect(itemEffectiveDifficulty({ difficulty: 950, timeLimitMs: null })).toBe(950);
  });
});

describe('itemTimeLimit (F12)', () => {
  const at = (D: number) => itemTimeLimit(D, structTarget(D, 9999));

  it('the limit starts at 30 s and shrinks from targetD 1000 (spec §4.8)', () => {
    expect([1000, 1100, 1200, 1300, 1400, 1600, 1800].map(at)).toEqual([30000, 25200, 21200, 17800, 15000, 10600, 8000]);
    expect(itemTimeLimit(999, 500)).toBe(30000);
    expect(structTarget(1100, 950)).toBe(950);
  });

  it('D_eff stays the targetD: the 30 s base adds 83', () => {
    for (let D = 1000; D <= 1700; D += 100) expect(Math.abs(effectiveDifficulty(structTarget(D, 9999), at(D)) - D)).toBeLessThanOrEqual(5);
  });

  it('structTarget: half of targetD + 417 under the family ceiling', () => {
    expect(structTarget(1000, 9999)).toBe(917);
    expect(structTarget(1300, 9999)).toBe(1067);
    expect(structTarget(809, 9999)).toBe(821.5);
    expect(structTarget(1300, 950)).toBe(950);
  });

  it('30 s below targetD 1000, whatever the item', () => {
    for (const dStruct of [500, 950, 1300, 1900]) expect(itemTimeLimit(999.9, dStruct)).toBe(30000);
    // From 1000 on, an item far below the target gets a short limit at once.
    expect(itemTimeLimit(1000, 500)).toBe(MIN_ITEM_LIMIT_MS);
  });

  it('never goes below 8 s nor above 30 s', () => {
    expect(itemTimeLimit(1500, 950)).toBe(8000);
    // An item above its target would earn more than 30 s.
    expect(itemTimeLimit(1100, 1150)).toBe(30000);
  });

  it('rejects inputs that are not finite', () => {
    expect(() => itemTimeLimit(Number.NaN, 950)).toThrow(RangeError);
    expect(() => itemTimeLimit(1000, Infinity)).toThrow(RangeError);
    expect(() => structTarget(Number.NaN, 950)).toThrow(RangeError);
    expect(() => structTarget(1000, -Infinity)).toThrow(RangeError);
  });

  // targetD is drawn around dStruct, so many runs land strictly inside (8000, 30000).
  // Integers in tenths: fc.double would crowd the offsets around 0.
  const dStruct = fc.integer({ min: 500, max: 2000 });
  const offset = fc.integer({ min: -3000, max: 8000 }).map((x) => x / 10);

  it('is a multiple of 100 in [8000, 30000]; strictly inside, it lands within 2 of targetD', () => {
    let inside = 0;
    fc.assert(
      fc.property(dStruct, offset, (d, gap) => {
        const targetD = d + gap;
        const limit = itemTimeLimit(targetD, d);
        expect(limit % 100).toBe(0);
        expect(limit).toBeGreaterThanOrEqual(MIN_ITEM_LIMIT_MS);
        expect(limit).toBeLessThanOrEqual(ITEM_LIMIT_START_MS);
        if (limit > MIN_ITEM_LIMIT_MS && limit < ITEM_LIMIT_START_MS) {
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
      fc.property(dStruct, offset, offset, (d, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(itemTimeLimit(d + hi, d)).toBeLessThanOrEqual(itemTimeLimit(d + lo, d));
      }),
      { numRuns: 1000 },
    );
  });
});
