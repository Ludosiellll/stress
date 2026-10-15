import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CV_HOLD_CAP,
  LAPSE_HOLD_CAP,
  TARGET,
  detectFatigue,
  isPlateau,
  levelDelta,
  nextLevel,
  savedLevel,
  stabilityHold,
  startLevel,
  type DeltaInput,
  type FatigueBlock,
} from './adaptive';

const input = (over: Partial<DeltaInput> = {}): DeltaInput => ({
  score: 0.8,
  calibration: false,
  prevScoreSameSession: null,
  cvAll: null,
  lapses: 0,
  lapseLimit: 2,
  cvMax: null,
  timingUnreliable: false,
  ...over,
});

const deltaInputArb = fc.record({
  score: fc.double({ min: 0, max: 1, noNaN: true }),
  calibration: fc.boolean(),
  prevScoreSameSession: fc.option(fc.double({ min: 0, max: 1, noNaN: true })),
  cvAll: fc.option(fc.double({ min: 0, max: 2, noNaN: true })),
  lapses: fc.nat({ max: 20 }),
  lapseLimit: fc.integer({ min: 2, max: 10 }),
  cvMax: fc.option(fc.double({ min: 0, max: 2, noNaN: true })),
  timingUnreliable: fc.boolean(),
});

describe('levelDelta', () => {
  it('targets 80% success', () => {
    expect(TARGET).toBe(0.8);
  });

  it('g = 1: ΔL = (s − 0.8) / 0.2', () => {
    expect(levelDelta(input({ score: 1 }))).toBe(1);
    expect(levelDelta(input({ score: 0.9 }))).toBe(0.5);
    expect(levelDelta(input({ score: 0.8 }))).toBe(0);
    expect(levelDelta(input({ score: 0.6 }))).toBe(-1);
  });

  it('clamps the drop at −2', () => {
    expect(levelDelta(input({ score: 0 }))).toBe(-2);
    expect(levelDelta(input({ score: 0.3 }))).toBe(-2);
  });

  it('score at target gives exactly +0, also within float noise of 0.8', () => {
    expect(Object.is(levelDelta(input({ score: 0.8 })), 0)).toBe(true);
    expect(Object.is(levelDelta(input({ score: 0.8, calibration: true })), 0)).toBe(true);
    // 0.1 + 0.7 === 0.7999999999999999
    expect(Object.is(levelDelta(input({ score: 0.1 + 0.7 })), 0)).toBe(true);
    expect(Object.is(levelDelta(input({ score: 0.1 + 0.7, calibration: true })), 0)).toBe(true);
  });

  it('g = 2 in calibration blocks', () => {
    expect(levelDelta(input({ score: 1, calibration: true }))).toBe(2);
    expect(levelDelta(input({ score: 0.9, calibration: true }))).toBe(1);
    expect(levelDelta(input({ score: 0.7, calibration: true }))).toBe(-1);
    expect(levelDelta(input({ score: 0, calibration: true }))).toBe(-2);
  });

  it('g = 2 after a block with s ≥ 0.95 in the same session', () => {
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 0.95 }))).toBe(2);
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 19 / 20 }))).toBe(2);
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 1 }))).toBe(2);
    expect(levelDelta(input({ score: 0.7, prevScoreSameSession: 1 }))).toBe(-1);
  });

  it('g = 1 when the previous block was below 0.95', () => {
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 0.9 }))).toBe(1);
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 14 / 15 }))).toBe(1);
  });

  it('g = 2 threshold tolerates float noise in the previous score only', () => {
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 0.95 - 1e-12 }))).toBe(2);
    expect(levelDelta(input({ score: 1, prevScoreSameSession: 0.95 - 1e-6 }))).toBe(1);
  });

  it('upper clamp: g = 2 and s = 1 gives 2, never above +3', () => {
    expect(levelDelta(input({ score: 1, calibration: true, prevScoreSameSession: 1 }))).toBe(2);
  });

  it('stays within [−2, +3] for any score and flags', () => {
    fc.assert(
      fc.property(deltaInputArb, (i) => {
        const d = levelDelta(i);
        return Number.isFinite(d) && d >= -2 && d <= 3;
      }),
      { numRuns: 1000 },
    );
  });

  it('a better score never gives a smaller step', () => {
    fc.assert(
      fc.property(
        deltaInputArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (i, other) => {
          const lo = Math.min(i.score, other);
          const hi = Math.max(i.score, other);
          return levelDelta({ ...i, score: lo }) <= levelDelta({ ...i, score: hi });
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('stability: the rule needs s above 0.8 and a module with cvMax', () => {
    expect(levelDelta(input({ score: 0.5, cvAll: 0.3, cvMax: 0.2, lapses: 5 }))).toBe(-1.5);
    expect(levelDelta(input({ score: 1, cvAll: 0.9, lapses: 9, cvMax: null }))).toBe(1);
  });

  it('stability: CV at the limit and lapses below it do not cap the rise', () => {
    expect(levelDelta(input({ score: 1, cvAll: 0.2, cvMax: 0.2, lapses: 1 }))).toBe(1);
    expect(levelDelta(input({ score: 1, cvAll: 0.1, cvMax: 0.2 }))).toBe(1);
  });

  it('stability only ever lowers the step, to at most its cap', () => {
    fc.assert(
      fc.property(deltaInputArb, (i) => {
        const d = levelDelta(i);
        const free = levelDelta({ ...i, cvMax: null });
        const hold = stabilityHold(i);
        return hold === null ? d === free : d === Math.min(free, hold.cap) && hold.held === hold.cap < free;
      }),
      { numRuns: 1000 },
    );
  });

  it('timing_unreliable block gives 0', () => {
    expect(levelDelta(input({ score: 1, timingUnreliable: true }))).toBe(0);
    expect(levelDelta(input({ score: 0, calibration: true, timingUnreliable: true }))).toBe(0);
    fc.assert(
      fc.property(deltaInputArb, (i) => levelDelta({ ...i, timingUnreliable: true }) === 0),
      { numRuns: 1000 },
    );
  });

  it('rejects a score outside [0, 1]', () => {
    expect(() => levelDelta(input({ score: Number.NaN }))).toThrow(RangeError);
    expect(() => levelDelta(input({ score: -0.05 }))).toThrow(RangeError);
    expect(() => levelDelta(input({ score: 1.05 }))).toThrow(RangeError);
  });
});

describe('stability rule (F2, F-R1)', () => {
  const base = { calibration: false, prevScoreSameSession: null, cvAll: 0.1, lapses: 0, lapseLimit: 2, cvMax: 0.22, timingUnreliable: false };
  it('F-R1: CV over cvMax caps the step at +0.5; lapses at the limit cap it at 0 and win', () => {
    expect(levelDelta({ ...base, score: 1 })).toBe(1);
    expect(levelDelta({ ...base, score: 1, cvAll: 0.23 })).toBe(0.5);
    expect(levelDelta({ ...base, score: 0.85, cvAll: 0.23 })).toBe(0.25);
    expect(levelDelta({ ...base, score: 1, lapses: 2 })).toBe(0);
    expect(levelDelta({ ...base, score: 1, cvAll: 0.3, lapses: 2 })).toBe(0);
    expect(levelDelta({ ...base, score: 1, calibration: true, cvAll: 0.3 })).toBe(0.5);
    expect(levelDelta({ ...base, score: 0.8, cvAll: 0.3, lapses: 5 })).toBe(0);
    expect(levelDelta({ ...base, score: 0.5, lapses: 5 })).toBe(-1.5);
    expect(levelDelta({ ...base, score: 1, cvAll: 0.3, lapses: 9, cvMax: null })).toBe(1);
    expect(levelDelta({ ...base, score: 1, cvAll: null })).toBe(1);
  });
  it('stabilityHold says which cap fired and whether it lowered the step', () => {
    expect(stabilityHold({ ...base, score: 1, cvAll: 0.3 })).toEqual({ cap: 0.5, held: true });
    expect(stabilityHold({ ...base, score: 0.85, cvAll: 0.3 })).toEqual({ cap: 0.5, held: false });
    expect(stabilityHold({ ...base, score: 0.9, lapses: 3 })).toEqual({ cap: 0, held: true });
    expect(stabilityHold({ ...base, score: 1 })).toBeNull();
    expect(stabilityHold({ ...base, score: 0.7, lapses: 3 })).toBeNull();
    expect(CV_HOLD_CAP).toBe(0.5);
  });

  it('the lapse cap is 0; a block whose timing is unreliable already moves by 0, so no cap lowers it', () => {
    expect(LAPSE_HOLD_CAP).toBe(0);
    expect(stabilityHold({ ...base, score: 1, lapses: 2, timingUnreliable: true })).toEqual({ cap: 0, held: false });
    expect(stabilityHold({ ...base, score: 1, cvAll: 0.3, timingUnreliable: true })).toEqual({ cap: 0.5, held: false });
  });

  it('stabilityHold rejects a score outside [0, 1] like levelDelta', () => {
    expect(() => stabilityHold({ ...base, score: Number.NaN })).toThrow(RangeError);
  });
});

describe('nextLevel', () => {
  it('adds the step', () => {
    expect(nextLevel(10, input({ score: 1 }))).toBe(11);
    expect(nextLevel(10, input({ score: 0.6 }))).toBe(9);
    expect(nextLevel(10, input({ score: 0.8 }))).toBe(10);
  });

  it('never goes below 0', () => {
    expect(nextLevel(0.5, input({ score: 0 }))).toBe(0);
    expect(nextLevel(0, input({ score: 0.6 }))).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), deltaInputArb, (L, i) => {
        const next = nextLevel(L, i);
        return Number.isFinite(next) && next >= 0;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('startLevel', () => {
  it('drops 2 levels after a short break', () => {
    expect(startLevel(10, 0)).toBe(8);
    expect(startLevel(10, 1)).toBe(8);
    expect(startLevel(10, 4)).toBe(8);
  });

  it('drops 3 levels after more than 4 days', () => {
    expect(startLevel(10, 5)).toBe(7);
    expect(startLevel(10, 4.5)).toBe(7);
    expect(startLevel(10, 30)).toBe(7);
  });

  it('never goes below 0', () => {
    expect(startLevel(1, 0)).toBe(0);
    expect(startLevel(0, 10)).toBe(0);
  });

  it('treats negative daysSince as 0', () => {
    expect(startLevel(10, -3)).toBe(8);
  });
});

describe('savedLevel', () => {
  it('is 0 without sessions', () => {
    expect(savedLevel([])).toBe(0);
  });

  it('is the median of the last three session-end levels', () => {
    expect(savedLevel([5])).toBe(5);
    expect(savedLevel([4, 6])).toBe(5);
    expect(savedLevel([1, 9, 4, 6])).toBe(6);
    expect(savedLevel([20, 20, 5])).toBe(20);
  });

  it('does not mutate the input', () => {
    const xs = [3, 1, 2];
    savedLevel(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('isPlateau', () => {
  it('needs 5 sessions after the last strict new maximum', () => {
    expect(isPlateau([1, 2, 3, 3, 3, 3, 3, 3])).toBe(true);
    expect(isPlateau([1, 2, 3, 3, 3, 3, 3])).toBe(false);
  });

  it('is false without history', () => {
    expect(isPlateau([])).toBe(false);
    expect(isPlateau([4])).toBe(false);
  });

  it('the first session is the initial maximum', () => {
    expect(isPlateau([5, 5, 5, 5, 5, 5])).toBe(true);
    expect(isPlateau([5, 4, 3, 2, 1, 0])).toBe(true);
    expect(isPlateau([5, 5, 5, 5, 5])).toBe(false);
  });

  it('a new maximum resets the count, a lower value does not', () => {
    expect(isPlateau([3, 2, 2, 2, 2, 4])).toBe(false);
    expect(isPlateau([3, 2, 2, 2, 2, 4, 1, 1, 1, 1])).toBe(false);
    expect(isPlateau([3, 2, 2, 2, 2, 4, 1, 1, 1, 1, 1])).toBe(true);
  });

  it('float noise in a level is not a new maximum', () => {
    const third = 1 / 3;
    const viaSum = third + third + third + third + third + third; // 1.9999999999999998
    expect(isPlateau([2, 2, 2, 2, 2, 2 + 1e-12])).toBe(true);
    expect(isPlateau([viaSum, 2, 2, 2, 2, 2])).toBe(true);
  });
});

const block = (hitRts: readonly number[], score: number): FatigueBlock => ({ hitRts, score });

describe('detectFatigue', () => {
  const fresh = block([300, 300], 0.9);
  const tired = block([340, 340], 0.7);

  it('needs at least 4 blocks', () => {
    expect(detectFatigue([])).toBe(false);
    expect(detectFatigue([fresh, tired, tired])).toBe(false);
  });

  it('RT rise > 12% and score drop ≥ 0.15 → fatigue', () => {
    expect(detectFatigue([fresh, fresh, tired, tired])).toBe(true);
  });

  it('RT rise of exactly 12% is not enough', () => {
    expect(detectFatigue([fresh, fresh, block([336, 336], 0.7), block([336, 336], 0.7)])).toBe(false);
    // 1.12 · 250 is exactly 280 in floating point: the rise must be strictly above 12%.
    const a = block([250, 250], 0.9);
    expect(detectFatigue([a, a, block([280, 280], 0.7), block([280, 280], 0.7)])).toBe(false);
    expect(detectFatigue([a, a, block([281, 281], 0.7), block([281, 281], 0.7)])).toBe(true);
  });

  it('RT rise of 20% with a score drop of 0.1 is not enough', () => {
    const slow = block([360, 360], 0.8);
    expect(detectFatigue([fresh, fresh, slow, slow])).toBe(false);
  });

  it('score drop of exactly 0.15 counts despite float noise', () => {
    // 0.95 − 0.8 === 0.1499999999999999 in floating point
    const a = block([300, 300], 0.95);
    const b = block([400, 400], 0.8);
    expect(detectFatigue([a, a, b, b])).toBe(true);
  });

  it('compares only the first two and the last two blocks', () => {
    const middle = block([2000], 0);
    expect(detectFatigue([fresh, fresh, middle, tired, tired])).toBe(true);
    expect(detectFatigue([fresh, fresh, middle, fresh, fresh])).toBe(false);
  });

  it('pools hit RTs of the two blocks before taking the median', () => {
    // pooled first [300, 400, 400, 400] → 400; 1.12 · 400 = 448 > 430.
    // A mean of per-block medians (350) would wrongly flag fatigue.
    const first = [block([300], 0.9), block([400, 400, 400], 0.9)];
    const last = [block([430, 430], 0.7), block([430, 430], 0.7)];
    expect(detectFatigue([...first, ...last])).toBe(false);
  });

  it('is false when either end has no hits', () => {
    const noHits = block([], 0);
    expect(detectFatigue([noHits, noHits, tired, tired])).toBe(false);
    expect(detectFatigue([fresh, fresh, noHits, noHits])).toBe(false);
  });

  it('pools hits even when one block of a pair has none', () => {
    expect(detectFatigue([fresh, block([], 0.9), tired, block([], 0.7)])).toBe(true);
  });
});
