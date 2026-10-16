import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { R0, targetDifficulty } from '../../engine/elo';
import { ITEM_LIMIT_START_MS, itemTimeLimit, structTarget } from '../../engine/itemLimit';
import { SERIES_FORMS, diagnosticSeriesSchedule } from '../../engine/diagnostic';
import { createRng, deriveSeed } from '../../engine/rng';
import { fitPredictions, isUnique } from './check';
import {
  ALL_FAMILIES,
  BASE_DIFFICULTY,
  HELD_OUT_FAMILIES,
  PREDICTOR_FAMILIES,
  SHOWN_LENGTH,
  TRAINING_FAMILIES,
  fitFamily,
  generateTerms,
  type FamilyId,
} from './families';
import {
  HELD_OUT_MIN_D,
  STRUCT_D_MAX,
  TRAINING_WINDOW,
  attemptItem,
  diagnosticAim,
  diagnosticSeriesItems,
  candidateItem,
  difficultyOf,
  generateBlockItems,
  generateItem,
  generateTrainingItem,
  selectCandidate,
  withoutRepeats,
} from './generate';

const family = fc.constantFrom(...ALL_FAMILIES);
/** R − targetDifficulty(R): the rating gap that gives P = 0.75. */
const targetGap = R0 - targetDifficulty(R0);
/** The 8 families of 0.1.0 and their predictors. */
const OLD_FAMILIES: readonly FamilyId[] = ALL_FAMILIES.slice(0, 8);

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

  it('a window takes the first candidate from targetD − below to targetD + above (F12)', () => {
    const { attempt, calls } = attempts({ 0: 1100, 1: 1030, 2: 900, 3: 1000 });
    // 1100 and 1030 lie above 1000 + 25; 900 is within 150 below.
    expect(selectCandidate(attempt, 1000, { below: 150, above: 25 })).toEqual({ attempt: 2, difficulty: 900 });
    expect(calls).toEqual([0, 1, 2]);
    expect(selectCandidate(attempts({ 0: 1100, 1: 1025 }).attempt, 1000, { below: 150, above: 25 })).toEqual({ attempt: 1, difficulty: 1025 });
    expect(selectCandidate(attempts({ 0: 849, 1: 850 }).attempt, 1000, { below: 150, above: 25 })).toEqual({ attempt: 1, difficulty: 850 });
    // Without one in the window, the closest of the first 200 attempts, above or below.
    expect(selectCandidate(attempts({ 0: 1100, 5: 1060, 9: 700 }).attempt, 1000, { below: 150, above: 25 })).toEqual({ attempt: 5, difficulty: 1060 });
    expect(TRAINING_WINDOW).toEqual({ below: 150, above: 25 });
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
          expect(SHOWN_LENGTH[f]).toContain(item.shown.length);
          expect(isUnique(item.shown, item.answer)).toBe(true);
          expect(fitFamily(f, item.shown).has(item.answer)).toBe(true);
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
    for (const f of ALL_FAMILIES) {
      const target = Math.max(1000, BASE_DIFFICULTY[f] + 200);
      const series = new Set(Array.from({ length: 20 }, (_, seed) => generateItem(f, target, seed).shown.join(',')));
      expect(series.size, f).toBeGreaterThan(10);
    }
  });

  it('hits the lowest difficulty of every family whenever asked for it', () => {
    // powstep keeps only cubes: squares of a progression are a second-order series (T-R70), and a cube of up to 21
    // passes 1000, so its lowest D is 1300 + 100 (p = 3) + 100 + 200 (size) = 1700.
    const lowest = (f: FamilyId): number => (f === 'powstep' ? 1700 : BASE_DIFFICULTY[f]);
    for (const f of ALL_FAMILIES) {
      for (let seed = 0; seed < 50; seed++) {
        expect(generateItem(f, lowest(f), seed).difficulty, f).toBeLessThanOrEqual(lowest(f) + 150);
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
    for (const f of ALL_FAMILIES) {
      let accepted = 0;
      for (let seed = 0; seed < 2000; seed++) if (attemptItem(f, seed, 0) !== null) accepted++;
      rates[f] = accepted / 2000;
    }
    for (const f of ALL_FAMILIES) expect(rates[f], f).toBeGreaterThan(0.5);
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
    // Unique (geom, linrec and fib give 96), but not arithmetic.
    expect(isUnique([3, 6, 12, 24, 48], 96)).toBe(true);
    expect(candidateItem('arith', 1, [3, 6, 12, 24, 48, 96])).toBeNull();
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
    new Map<FamilyId, number>(TRAINING_FAMILIES.map((f) => [f, overrides[f] ?? rating]));

  it('gives the strongest family less than its share', () => {
    const items = generateBlockItems(others(1000, { arith: 1400 }), 1000, createRng(7));
    expect(items).toHaveLength(1000);
    const arith = items.filter((it) => it.family === 'arith').length;
    expect(arith).toBeLessThan(1000 / TRAINING_FAMILIES.length);
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

  it('gives every item 30 s while all ratings are 1000 (F12)', () => {
    const items = generateBlockItems(others(1000, {}), 60, createRng(13));
    for (const item of items) expect(item.timeLimitMs, item.id).toBe(ITEM_LIMIT_START_MS);
  });

  it('shortens the limit of every arith item for an arith rating of 1700', () => {
    const items = generateBlockItems(others(1000, { arith: 1700 }), 300, createRng(17));
    const arith = items.filter((it) => it.family === 'arith');
    expect(arith.length).toBeGreaterThan(0);
    for (const item of arith) expect(item.timeLimitMs, item.id).toBeLessThan(ITEM_LIMIT_START_MS);
  }, 60_000);
});

describe('STRUCT_D_MAX', () => {
  it('the ceilings of the new families are what their generation ranges reach (spec §4.8, T-R68)', () => {
    // The table's D_struct terms at their highest over its own ranges: letters 1000 + 200 (two series) + 100 (a step of
    // 3 or more) + 50 (both falling); addsub 1050 + 200 (a cycle of 3) + 100 (above 100; such a series never goes below
    // 0); primes 1150 + 100 + 100 + 50 (P(22) + 5 = 88: never above 100); powstep 1300 + 100 + 50 + 350 (21³ with a
    // negative first term); twostep 1400 + 100 + 100 + 300 (above 1000, only growing); digitsum 1350 + 100 + 100 + 100
    // (never negative, never above 1000).
    expect(STRUCT_D_MAX).toMatchObject({ letters: 1350, addsub: 1350, primes: 1400, powstep: 1800, twostep: 1900, digitsum: 1650 });
  });

  it('bounds every generated candidate of every family', () => {
    fc.assert(
      fc.property(family, fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: 199 }), (f, seed, attempt) => {
        expect(attemptItem(f, seed, attempt)?.difficulty ?? 0).toBeLessThanOrEqual(STRUCT_D_MAX[f]);
      }),
      { numRuns: 1000 * ALL_FAMILIES.length },
    );
  }, 120_000);

  it('is reached by every family', () => {
    for (const f of ALL_FAMILIES) {
      const reached = Array.from({ length: 50 }, (_, seed) => seed).some(
        (seed) => generateItem(f, 5000, seed).difficulty === STRUCT_D_MAX[f],
      );
      expect(reached, f).toBe(true);
    }
  }, 120_000);
});

describe('generateTrainingItem', () => {
  it('training items get 30 s below targetD 1000 (F12)', () => {
    for (let seed = 0; seed <= 20; seed++) expect(generateTrainingItem('arith', 900, seed).timeLimitMs).toBe(30000);
  });

  it('training items aim at structTarget and shorten the limit from targetD 1000 (F12)', () => {
    // arith tops out at 950: the target is its ceiling, the limit makes up the rest of targetD 1300.
    const item = generateTrainingItem('arith', 1300, 7);
    expect(item.difficulty).toBe(900);
    expect(item.timeLimitMs).toBe(10_000);
    expect(itemTimeLimit(1300, 950)).toBe(11_900);
    // geom at targetD 1300 aims at 0,5·1300 + 417 = 1067, under its ceiling of 1300, and takes 917…1092.
    const geom = generateTrainingItem('geom', 1300, 3);
    expect(geom.difficulty).toBeGreaterThanOrEqual(917);
    expect(geom.difficulty).toBeLessThanOrEqual(1092);
    expect(geom.timeLimitMs).toBeLessThanOrEqual(itemTimeLimit(1300, 1092));
  });

  it('a training item is the first candidate within TRAINING_WINDOW of structTarget, with the limit of its own difficulty (F12)', () => {
    fc.assert(
      fc.property(
        family,
        fc.double({ min: 700, max: 2600, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (f, targetD, seed) => {
          const { timeLimitMs, ...item } = generateTrainingItem(f, targetD, seed);
          expect(item).toEqual(selectCandidate((i) => attemptItem(f, seed, i), structTarget(targetD, STRUCT_D_MAX[f]), TRAINING_WINDOW));
          expect(isUnique(item.shown, item.answer)).toBe(true);
          // A training item always has its own limit (the type says so): the one itemTimeLimit gives.
          const limit: number = timeLimitMs;
          expect(limit).toBe(itemTimeLimit(targetD, item.difficulty));
        },
      ),
      { numRuns: 1000 },
    );
  }, 60_000);
});

describe('the new families (F12)', () => {
  it('a candidate of any family is unique over the 13 numeric predictors; terms stay within ±100 000; letter positions within 1…32', () => {
    for (const f of ALL_FAMILIES) {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: 199 }), (seed, attempt) => {
          const item = attemptItem(f, seed, attempt);
          if (item === null) return;
          expect(SHOWN_LENGTH[f]).toContain(item.shown.length);
          expect(isUnique(item.shown, item.answer, PREDICTOR_FAMILIES)).toBe(true);
          expect(fitFamily(f, item.shown).has(item.answer)).toBe(true);
          const terms = [...item.shown, item.answer];
          for (const x of terms) expect(Math.abs(x)).toBeLessThanOrEqual(100000);
          if (f === 'letters') for (const x of terms) expect(x >= 1 && x <= 32, terms.join(',')).toBe(true);
        }),
        { numRuns: 1000 },
      );
    }
  }, 120_000);

  it('a letter series is checked by its positions against every numeric predictor', () => {
    // 1, 2, 4, 7 is second order (→ 11) and Fibonacci-like (k = 1, c = 1 → 12): two answers.
    expect(fitFamily('letters', [1, 2, 4, 7])).toEqual(new Set([11]));
    expect(fitPredictions([1, 2, 4, 7]).get('fib')).toEqual(new Set([12]));
    expect(candidateItem('letters', 1, [1, 2, 4, 7, 11])).toBeNull();
    // Positions outside 1…32 are no letters.
    expect(candidateItem('letters', 1, [20, 23, 26, 29, 32, 35])).toBeNull();
    expect(candidateItem('letters', 1, [2, 5, 8, 11, 14, 17])).toEqual({
      id: 'letters:1',
      family: 'letters',
      seed: 1,
      shown: [2, 5, 8, 11, 14],
      answer: 17,
      difficulty: 1100,
    });
  });

  it('the acceptance of the old families drops by at most 1 point', () => {
    for (const f of OLD_FAMILIES) {
      let old = 0;
      let now = 0;
      for (let seed = 0; seed < 5000; seed++) {
        const terms = generateTerms(f, createRng(deriveSeed(seed, 'attempt:0')));
        if (candidateItem(f, seed, terms) !== null) now++;
        const shown = terms.slice(0, -1);
        const answer = terms[terms.length - 1] as number;
        const basic = terms.every((x) => Math.abs(x) <= 100000) && new Set(terms).size >= 3 && fitFamily(f, shown).has(answer);
        if (basic && isUnique(shown, answer, OLD_FAMILIES)) old++;
      }
      expect(now / 5000, f).toBeGreaterThanOrEqual(old / 5000 - 0.01);
    }
  }, 120_000);

  it('a held-out item never reduces to a training family, even with the same answer (T-R70)', () => {
    // A digit-sum series over multiples of 9 is a +9 progression; squares of a progression are a second-order series.
    expect(fitFamily('arith', [18, 27, 36, 45, 54]).has(63)).toBe(true);
    expect(isUnique([18, 27, 36, 45, 54], 63)).toBe(true);
    expect(candidateItem('digitsum', 1, [18, 27, 36, 45, 54, 63])).toBeNull();
    expect(candidateItem('powstep', 1, [9, 36, 81, 144, 225, 324])).toBeNull();
    // A training family keeps such a series: the rule is for the held-out families only.
    expect(candidateItem('second', 1, [9, 36, 81, 144, 225, 324])?.answer).toBe(324);
    // A digit-sum series no training rule fits stays.
    expect(fitPredictions([19, 29, 40, 44, 52], TRAINING_FAMILIES).size).toBe(0);
    expect(candidateItem('digitsum', 1, [19, 29, 40, 44, 52, 59])?.answer).toBe(59);
    // Any accepted candidate of a held-out family, with the training rules' wide predictor ranges.
    for (const f of HELD_OUT_FAMILIES) {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: 199 }), (seed, attempt) => {
          const item = attemptItem(f, seed, attempt);
          if (item !== null) expect(fitPredictions(item.shown, TRAINING_FAMILIES), item.id).toEqual(new Map());
        }),
        { numRuns: 1000 },
      );
    }
  }, 120_000);

  it('the held-out items of the six diagnostic forms reduce to no training family (T-R70)', () => {
    for (let seedIndex = 1; seedIndex <= SERIES_FORMS; seedIndex++) {
      for (const [i, item] of diagnosticSeriesItems(seedIndex).entries()) {
        if (!HELD_OUT_FAMILIES.includes(item.family)) continue;
        expect(fitPredictions(item.shown, TRAINING_FAMILIES), `form ${String(seedIndex - 1)} №${String(i + 1)}`).toEqual(new Map());
      }
    }
  });

  it('held-out families still generate within the table of spec §4.8 (T-R70)', () => {
    // Acceptance at the first attempt, and the D_struct each family still reaches.
    const seen = new Map<FamilyId, { accepted: number; ds: Set<number> }>();
    for (const f of HELD_OUT_FAMILIES) {
      const s = { accepted: 0, ds: new Set<number>() };
      for (let seed = 0; seed < 2000; seed++) {
        const item = attemptItem(f, seed, 0);
        if (item === null) continue;
        s.accepted++;
        s.ds.add(item.difficulty);
      }
      seen.set(f, s);
    }
    const accepted = (f: FamilyId): number => (seen.get(f)?.accepted ?? 0) / 2000;
    const range = (f: FamilyId): number[] => {
      const ds = [...(seen.get(f)?.ds ?? [])];
      return [Math.min(...ds), Math.max(...ds)];
    };
    // powstep loses its squares (about half its candidates); digitsum some series over multiples of 9.
    expect(accepted('powstep')).toBeGreaterThan(0.45);
    expect(accepted('twostep')).toBeGreaterThan(0.95);
    expect(accepted('digitsum')).toBeGreaterThan(0.85);
    expect(range('powstep')).toEqual([1700, STRUCT_D_MAX.powstep]);
    expect(range('twostep')).toEqual([1500, STRUCT_D_MAX.twostep]);
    expect(range('digitsum')).toEqual([BASE_DIFFICULTY.digitsum, STRUCT_D_MAX.digitsum]);
  });

  it('HELD_OUT_MIN_D is the lowest D each held-out family reaches after T-R70', () => {
    expect(HELD_OUT_MIN_D).toEqual({ powstep: 1700, twostep: 1500, digitsum: 1350 });
    fc.assert(
      fc.property(fc.constantFrom(...HELD_OUT_FAMILIES), fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: 199 }), (f, seed, attempt) => {
        const item = attemptItem(f, seed, attempt);
        if (item !== null) expect(item.difficulty).toBeGreaterThanOrEqual(HELD_OUT_MIN_D[f as keyof typeof HELD_OUT_MIN_D]);
      }),
      { numRuns: 1000 },
    );
    for (const f of HELD_OUT_FAMILIES) {
      const lowest = HELD_OUT_MIN_D[f as keyof typeof HELD_OUT_MIN_D];
      expect(Array.from({ length: 200 }, (_, seed) => attemptItem(f, seed, 0)?.difficulty), f).toContain(lowest);
    }
  });

  it('diagnosticAim: a held-out item at least 75 above its family\'s lowest D, any other at its target (T-R72)', () => {
    expect(diagnosticAim('powstep', 1050)).toBe(1775);
    expect(diagnosticAim('twostep', 1470)).toBe(1575);
    expect(diagnosticAim('digitsum', 1380)).toBe(1425);
    expect(diagnosticAim('digitsum', 1500)).toBe(1500);
    expect(diagnosticAim('arith', 900)).toBe(900);
    expect(diagnosticAim('letters', 930)).toBe(930);
  });

  it('withoutRepeats takes an item\'s next seed while its shown terms repeat an earlier item, up to 100 (T-R72)', () => {
    const calls: [number, number][] = [];
    const items = withoutRepeats(3, (i, retry) => {
      calls.push([i, retry]);
      // Items 1 and 2 first repeat item 0; item 2 also its own first retry's terms of item 1.
      const shown = i === 0 || retry === 0 ? [1, 2, 3] : i === 2 && retry === 1 ? [1, 1, 9] : [i, retry, 9];
      return { shown };
    });
    expect(items.map((it) => it.shown)).toEqual([[1, 2, 3], [1, 1, 9], [2, 2, 9]]);
    expect(calls).toEqual([[0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [2, 2]]);
    expect(() => withoutRepeats(2, () => ({ shown: [1, 2, 3] }))).toThrow(/item 2 repeats an earlier one after 100 next seeds/);
  });

  it('the six diagnostic forms: no repeated item, held-out items across their lower band, means within 40 of each other (T-R72)', () => {
    // Means of D by form (spec order of forms 0–5): 1382.5, 1392.5, 1377.5, 1380.0, 1380.0, 1370.0 (SD 260–272), average
    // 1380.4: the largest gap is 12.1, so no rebalancing.
    const forms = Array.from({ length: SERIES_FORMS }, (_, i) => diagnosticSeriesItems(i + 1));
    const schedule = diagnosticSeriesSchedule();
    const means = forms.map((items) => items.reduce((sum, it) => sum + it.difficulty, 0) / items.length);
    const average = means.reduce((sum, m) => sum + m, 0) / means.length;
    for (const [f, items] of forms.entries()) {
      expect(items.map((it) => it.family), `form ${String(f)}`).toEqual(schedule.map((e) => e.family));
      expect(new Set(items.map((it) => it.shown.join(','))).size, `form ${String(f)}`).toBe(items.length);
      expect(Math.abs((means[f] as number) - average), `form ${String(f)}`).toBeLessThanOrEqual(40);
      for (const it of items) {
        if (!HELD_OUT_FAMILIES.includes(it.family)) continue;
        const lowest = HELD_OUT_MIN_D[it.family as keyof typeof HELD_OUT_MIN_D];
        expect(it.difficulty - lowest, it.id).toBeGreaterThanOrEqual(0);
        expect(it.difficulty - lowest, it.id).toBeLessThanOrEqual(225);
      }
    }
    // The held-out items vary within their band: no single D takes every powstep or twostep item.
    for (const f of ['powstep', 'twostep'] as const) {
      expect(new Set(forms.flat().filter((it) => it.family === f).map((it) => it.difficulty)).size, f).toBeGreaterThan(1);
    }
    // The first items of a form are the form's first items (the e2e scale plays 3).
    expect(diagnosticSeriesItems(4, 3)).toEqual(forms[3]?.slice(0, 3));
    // Diagnostic 7 plays form 0 again.
    expect(diagnosticSeriesItems(7)).toEqual(forms[0]);
  }, 60_000);

  it('held-out families never appear in training', () => {
    // Which families come up depends on the weights only. Ratings that put each family's structural target 50 above its
    // base keep the targets reachable: from R0 most families would search all 200 attempts for each item (120 s on CI).
    const reachable = new Map<FamilyId, number>(TRAINING_FAMILIES.map((f) => [f, 2 * (BASE_DIFFICULTY[f] + 50 - 417) + targetGap]));
    const items = generateBlockItems(reachable, 10_000, createRng(20));
    expect(items).toHaveLength(10_000);
    const families = new Set(items.map((it) => it.family));
    for (const f of HELD_OUT_FAMILIES) expect(families.has(f), f).toBe(false);
    expect([...families].sort()).toEqual([...TRAINING_FAMILIES].sort());
  }, 120_000);
});
