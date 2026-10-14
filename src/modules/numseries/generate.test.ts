import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { R0, targetDifficulty } from '../../engine/elo';
import { createRng } from '../../engine/rng';
import { fitPredictions, isUnique } from './check';
import { BASE_DIFFICULTY, FAMILIES, SHOWN_LENGTH, type FamilyId } from './families';
import {
  ITEM_TIME_LIMIT_MS,
  attemptItem,
  difficultyOf,
  generateBlockItems,
  generateItem,
  selectCandidate,
} from './generate';

const family = fc.constantFrom(...FAMILIES);

describe('difficultyOf', () => {
  it('is the base difficulty for small non-negative numbers', () => {
    expect(difficultyOf('arith', [1, 2, 3, 4, 5], 6)).toBe(800);
    expect(difficultyOf('opcycle', [0, 100, 0], 100)).toBe(1400);
  });

  it('adds 100 above |100| and another 200 above |1000|', () => {
    expect(difficultyOf('geom', [1, 2, 4], 101)).toBe(1050);
    expect(difficultyOf('geom', [1, 1000, 4], 8)).toBe(1050);
    expect(difficultyOf('geom', [1, 1001, 4], 8)).toBe(1250);
  });

  it('adds 50 for negative numbers, by absolute size too', () => {
    expect(difficultyOf('second', [3, 1, -1], 5)).toBe(1200);
    expect(difficultyOf('second', [3, 1, 0], -101)).toBe(1300);
    expect(difficultyOf('fib', [-1001, 1, 0], 5)).toBe(1600);
  });

  it('counts the answer', () => {
    expect(difficultyOf('alt', [1, 2, 3], 2000)).toBe(1350);
    expect(difficultyOf('alt', [1, 2, 3], -1)).toBe(1100);
  });
});

describe('selectCandidate', () => {
  type Fake = { attempt: number; difficulty: number };
  /** Attempts take their difficulty from the table; missing entries are rejected. */
  const attempts = (table: Record<number, number>) => {
    const calls: number[] = [];
    const attempt = (i: number): Fake | null => {
      calls.push(i);
      const d = table[i];
      return d === undefined ? null : { attempt: i, difficulty: d };
    };
    return { attempt, calls };
  };

  it('returns the first accepted candidate within 150 of the target', () => {
    const { attempt, calls } = attempts({ 0: 1300, 1: 1150, 2: 1000, 3: 1000 });
    expect(selectCandidate(attempt, 1000)).toEqual({ attempt: 1, difficulty: 1150 });
    expect(calls).toEqual([0, 1]);
  });

  it('otherwise takes the closest of the first 200 attempts, the earliest on ties', () => {
    const { attempt, calls } = attempts({ 3: 1400, 10: 650, 50: 1350, 199: 1350, 250: 1000 });
    expect(selectCandidate(attempt, 1000)).toEqual({ attempt: 10, difficulty: 650 });
    expect(calls).toHaveLength(200);
  });

  it('after 200 attempts with nothing accepted, takes the next accepted one', () => {
    const { attempt, calls } = attempts({ 700: 2000, 701: 1000 });
    expect(selectCandidate(attempt, 1000)).toEqual({ attempt: 700, difficulty: 2000 });
    expect(calls).toHaveLength(701);
  });

  it('throws after 2000 attempts with nothing accepted', () => {
    const { attempt, calls } = attempts({ 2000: 1000 });
    expect(() => selectCandidate(attempt, 1000)).toThrow(Error);
    expect(calls).toHaveLength(2000);
  });
});

describe('generateItem', () => {
  it('main property: unique, own family fits, bounded integers, family length, consistent difficulty', () => {
    fc.assert(
      fc.property(
        family,
        fc.double({ min: 700, max: 1800, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (f, targetD, seed) => {
          const item = generateItem(f, targetD, seed);
          expect(item.family).toBe(f);
          expect(item.seed).toBe(seed);
          expect(item.id).toBe(`${f}:${String(seed)}`);
          expect(item.shown).toHaveLength(SHOWN_LENGTH[f]);
          expect(isUnique(item.shown, item.answer)).toBe(true);
          expect(fitPredictions(item.shown).get(f)?.has(item.answer)).toBe(true);
          for (const x of [...item.shown, item.answer]) {
            expect(Number.isInteger(x)).toBe(true);
            expect(Math.abs(x)).toBeLessThanOrEqual(100000);
          }
          expect(item.difficulty).toBe(difficultyOf(f, item.shown, item.answer));
        },
      ),
      { numRuns: 2000 },
    );
  }, 60_000);

  it('is deterministic in (family, targetD, seed)', () => {
    fc.assert(
      fc.property(
        family,
        fc.double({ min: 700, max: 1800, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (f, targetD, seed) => {
          expect(generateItem(f, targetD, seed)).toEqual(generateItem(f, targetD, seed));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('varies with the seed', () => {
    for (const f of FAMILIES) {
      const series = new Set(Array.from({ length: 20 }, (_, seed) => generateItem(f, 1000, seed).shown.join(',')));
      expect(series.size, f).toBeGreaterThan(10);
    }
  });

  it('hits the base difficulty of every family whenever asked for it', () => {
    for (const f of FAMILIES) {
      for (let seed = 0; seed < 50; seed++) {
        expect(generateItem(f, BASE_DIFFICULTY[f], seed).difficulty, f).toBeLessThanOrEqual(BASE_DIFFICULTY[f] + 150);
      }
    }
  });

  it('gets as close as it can when the target is out of reach', () => {
    // arith never exceeds |350|, so 950 (>100 with negatives) is its ceiling.
    for (let seed = 0; seed < 20; seed++) expect(generateItem('arith', 1800, seed).difficulty).toBe(950);
    // geom tops out at 950 + 100 + 200 + 50 = 1300: past ±1000 with a negative ratio.
    for (let seed = 0; seed < 20; seed++) expect(generateItem('geom', 1800, seed).difficulty).toBe(1300);
  });

  it('rejects a target difficulty that is not finite', () => {
    expect(() => generateItem('arith', Number.NaN, 1)).toThrow(RangeError);
    expect(() => generateItem('arith', Infinity, 1)).toThrow(RangeError);
  });

  it('accepts most attempts in every family, so 200 attempts never run dry', () => {
    const rates: Record<string, number> = {};
    for (const f of FAMILIES) {
      let accepted = 0;
      for (let seed = 0; seed < 2000; seed++) if (attemptItem(f, seed, 0) !== null) accepted++;
      rates[f] = accepted / 2000;
    }
    for (const f of FAMILIES) expect(rates[f], f).toBeGreaterThan(0.5);
  });
});

describe('attemptItem', () => {
  it('is the candidate generateItem returns when it is close enough', () => {
    for (let seed = 0; seed < 50; seed++) {
      const first = attemptItem('geom', seed, 0);
      if (first === null) continue;
      expect(generateItem('geom', first.difficulty, seed)).toEqual(first);
    }
  });
});

describe('generateBlockItems', () => {
  const others = (rating: number, overrides: Partial<Record<FamilyId, number>>) =>
    new Map<FamilyId, number>(FAMILIES.map((f) => [f, overrides[f] ?? rating]));

  it('gives the strongest family less than its share', () => {
    const items = generateBlockItems(others(1000, { arith: 1400 }), 1000, createRng(7));
    expect(items).toHaveLength(1000);
    const arith = items.filter((it) => it.family === 'arith').length;
    expect(arith).toBeLessThan(1000 / FAMILIES.length);
  }, 60_000);

  it('aims each item at the family rating', () => {
    const items = generateBlockItems(others(1000, { geom: 1600 }), 60, createRng(3));
    for (const item of items) {
      const target = targetDifficulty(item.family === 'geom' ? 1600 : 1000);
      expect(item).toEqual(generateItem(item.family, target, item.seed));
    }
  });

  it('uses R0 for families without a rating', () => {
    const items = generateBlockItems(new Map(), 40, createRng(11));
    expect(new Set(items.map((it) => it.family)).size).toBeGreaterThan(5);
    for (const item of items) {
      expect(item).toEqual(generateItem(item.family, targetDifficulty(R0), item.seed));
      expect(item.seed).toBeGreaterThanOrEqual(0);
      expect(item.seed).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  it('is deterministic in the rng and returns nothing for count 0', () => {
    const ratings = others(1100, {});
    expect(generateBlockItems(ratings, 10, createRng(5))).toEqual(generateBlockItems(ratings, 10, createRng(5)));
    expect(generateBlockItems(ratings, 0, createRng(5))).toEqual([]);
  });

  it('rejects a count that is not a non-negative integer', () => {
    expect(() => generateBlockItems(new Map(), -1, createRng(1))).toThrow(RangeError);
    expect(() => generateBlockItems(new Map(), 2.5, createRng(1))).toThrow(RangeError);
  });
});

describe('ITEM_TIME_LIMIT_MS', () => {
  it('is 40 s', () => {
    expect(ITEM_TIME_LIMIT_MS).toBe(40000);
  });
});
