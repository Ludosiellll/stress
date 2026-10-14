import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { R0, targetDifficulty } from '../../engine/elo';
import { BASE_ITEM_LIMIT_MS } from '../../engine/itemLimit';
import { createRng, deriveSeed } from '../../engine/rng';
import { fitPredictions, isUnique } from './check';
import { BASE_DIFFICULTY, FAMILIES, SHOWN_LENGTH, generateTerms, type FamilyId } from './families';
import {
  ITEM_TIME_LIMIT_MS,
  STRUCT_D_MAX,
  attemptItem,
  candidateItem,
  difficultyOf,
  generateBlockItems,
  generateItem,
  generateTrainingItem,
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
  it('main property: unique, own family fits, bounded integers, ≥3 distinct values, family length, consistent difficulty', () => {
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
          expect(new Set([...item.shown, item.answer]).size).toBeGreaterThanOrEqual(3);
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

describe('candidateItem', () => {
  // Under the reference ranges the generator never produces the out-of-range, own-fit-miss or
  // non-unique cases, so they are checked here on hand-made series.
  it('accepts a unique series of its own family', () => {
    expect(candidateItem('arith', 7, [2, 4, 6, 8, 10, 12])).toEqual({
      id: 'arith:7',
      family: 'arith',
      seed: 7,
      shown: [2, 4, 6, 8, 10],
      answer: 12,
      difficulty: 800,
    });
  });

  it('allows ±100000 and rejects anything beyond', () => {
    expect(candidateItem('geom', 1, [1, 10, 100, 1000, 10000, 100000])?.answer).toBe(100000);
    expect(candidateItem('geom', 1, [-1, -10, -100, -1000, -10000, -100000])?.answer).toBe(-100000);
    expect(candidateItem('geom', 1, [5, 50, 500, 5000, 50000, 500000])).toBeNull();
  });

  it('rejects fewer than 3 distinct values (R13)', () => {
    expect(candidateItem('fib', 1, [3, 3, 3, 3, 3, 3, 3])).toBeNull();
    expect(candidateItem('fib', 1, [2, 1, 2, 1, 2, 1, 2])).toBeNull();
  });

  it('rejects a series its own family does not continue with the answer', () => {
    // Unique (geom, linrec and fib give 32), but not arithmetic.
    expect(isUnique([1, 2, 4, 8, 16], 32)).toBe(true);
    expect(candidateItem('arith', 1, [1, 2, 4, 8, 16, 32])).toBeNull();
  });

  it('rejects a series with two justified answers', () => {
    // [1, 2, 4, 7]: second → 11, fib (k=1, c=1) → 12.
    expect(candidateItem('second', 1, [1, 2, 4, 7, 11])).toBeNull();
    expect(candidateItem('fib', 1, [1, 2, 4, 7, 12])).toBeNull();
  });
});

describe('attemptItem', () => {
  it('rejects constant and 2-cycle series even though they are unique (R13)', () => {
    /** Raw fib terms of attempt 0 for `seed`, as attemptItem draws them. */
    const raw = (seed: number) => generateTerms('fib', createRng(deriveSeed(seed, 'attempt:0')));
    const firstSeed = (pred: (t: number[]) => boolean): number => {
      for (let seed = 0; seed < 20000; seed++) if (pred(raw(seed))) return seed;
      throw new Error('no such seed');
    };
    const constant = firstSeed((t) => new Set(t).size === 1);
    const twoCycle = firstSeed((t) => new Set(t).size === 2 && t.every((x, i) => x === t[i % 2]));
    for (const seed of [constant, twoCycle]) {
      const t = raw(seed);
      const shown = t.slice(0, -1);
      const answer = t[t.length - 1] as number;
      expect(isUnique(shown, answer)).toBe(true);
      expect(fitPredictions(shown).get('fib')?.has(answer)).toBe(true);
      expect(attemptItem('fib', seed, 0)).toBeNull();
    }
  });

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
      expect(item).toEqual(generateTrainingItem(item.family, target, item.seed));
    }
  });

  it('uses R0 for families without a rating', () => {
    const items = generateBlockItems(new Map(), 40, createRng(11));
    expect(new Set(items.map((it) => it.family)).size).toBeGreaterThan(5);
    for (const item of items) {
      expect(item).toEqual(generateTrainingItem(item.family, targetDifficulty(R0), item.seed));
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

  it('keeps 40 s on every item while all ratings are 1000', () => {
    const items = generateBlockItems(others(1000, {}), 60, createRng(13));
    for (const item of items) expect(item.timeLimitMs, item.id).toBe(40000);
  });

  it('shortens the limit of every arith item for an arith rating of 1700', () => {
    const items = generateBlockItems(others(1000, { arith: 1700 }), 300, createRng(17));
    const arith = items.filter((it) => it.family === 'arith');
    expect(arith.length).toBeGreaterThan(0);
    for (const item of arith) expect(item.timeLimitMs, item.id).toBeLessThan(40000);
  }, 60_000);
});

describe('STRUCT_D_MAX', () => {
  it('bounds every generated candidate', () => {
    fc.assert(
      fc.property(
        family,
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 0, max: 199 }),
        (f, seed, attempt) => {
          expect(attemptItem(f, seed, attempt)?.difficulty ?? 0).toBeLessThanOrEqual(STRUCT_D_MAX[f]);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('is reached', () => {
    for (const f of FAMILIES) {
      const reached = Array.from({ length: 50 }, (_, seed) => seed).some(
        (seed) => generateItem(f, 5000, seed).difficulty === STRUCT_D_MAX[f],
      );
      expect(reached, f).toBe(true);
    }
  }, 60_000);
});

describe('generateTrainingItem', () => {
  it('training items keep 40 s up to the family maximum', () => {
    for (let seed = 0; seed <= 20; seed++) expect(generateTrainingItem('arith', 900, seed).timeLimitMs).toBe(40000);
  });

  it('training items shorten the limit above it', () => {
    const item = generateTrainingItem('arith', 1300, 7);
    expect(item.difficulty).toBe(950);
    expect(item.timeLimitMs).toBe(11900);
  });

  it('the lever leaves the item itself unchanged', () => {
    fc.assert(
      fc.property(
        family,
        fc.double({ min: 700, max: 2600, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (f, targetD, seed) => {
          const { timeLimitMs, ...item } = generateTrainingItem(f, targetD, seed);
          expect(item).toEqual(generateItem(f, targetD, seed));
          expect(isUnique(item.shown, item.answer)).toBe(true);
          expect(timeLimitMs).not.toBeNull();
        },
      ),
      { numRuns: 1000 },
    );
  }, 60_000);
});

describe('ITEM_TIME_LIMIT_MS', () => {
  it('is 40 s, the engine base limit', () => {
    expect(ITEM_TIME_LIMIT_MS).toBe(40000);
    expect(ITEM_TIME_LIMIT_MS).toBe(BASE_ITEM_LIMIT_MS);
  });
});
