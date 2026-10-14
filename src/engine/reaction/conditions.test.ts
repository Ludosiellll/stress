import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REACTION_MODULE_IDS } from '../types';
import { COND_PAIRS, condCost, condPairOf, conditionStats, MIN_COND_RTS, type ConditionStats } from './conditions';
import type { TrialCond, TrialResult, TrialSpec } from './types';

const spec = (cond?: TrialCond, practice = false): TrialSpec => ({
  isiMs: 500,
  windowMs: 2000,
  stimulus: { kind: 'word', word: 'red', ink: 'green' },
  expected: { kind: 'press', key: 'KeyJ' },
  ...(cond === undefined ? {} : { cond }),
  ...(practice ? { practice } : {}),
});

const hit = (idx: number, rtMs: number, over: Partial<TrialResult> = {}): TrialResult => ({
  idx,
  kind: 'press',
  outcome: 'hit',
  success: true,
  rtMs,
  errorMs: null,
  key: 'KeyJ',
  frameDropped: false,
  practice: false,
  ...over,
});

const wrong = (idx: number, rtMs: number): TrialResult => hit(idx, rtMs, { outcome: 'wrong', success: false, key: 'KeyF' });

describe('conditionStats', () => {
  it('counts trials, errors and the median RT of hits per condition', () => {
    const specs = [...Array<TrialCond>(4).fill('congruent'), ...Array<TrialCond>(4).fill('incongruent')].map((c) => spec(c));
    const results = [
      hit(0, 400),
      hit(1, 420),
      hit(2, 440),
      hit(3, 460),
      hit(4, 500),
      hit(5, 520),
      hit(6, 560),
      wrong(7, 480),
    ];
    const stats = conditionStats(specs, results);
    expect(stats).toEqual({
      congruent: { n: 4, errors: 0, medianRt: 430 },
      incongruent: { n: 4, errors: 1, medianRt: 520 },
    });
    expect(condCost(stats, 'incongruent', 'congruent')).toBe(90);
  });

  it('leaves practice trials out of everything', () => {
    const specs = [spec('congruent', true), spec('congruent', true), ...Array.from({ length: 3 }, () => spec('congruent'))];
    const results = [hit(0, 100, { practice: true }), { ...wrong(1, 900), practice: true }, hit(2, 400), hit(3, 410), hit(4, 420)];
    expect(conditionStats(specs, results)).toEqual({ congruent: { n: 3, errors: 0, medianRt: 410 } });
  });

  it('a trial with a dropped onset frame counts in n but not in the median', () => {
    const specs = Array.from({ length: 4 }, () => spec('quiet'));
    const results = [hit(0, 400), hit(1, 410), hit(2, 420), hit(3, 100, { frameDropped: true })];
    expect(conditionStats(specs, results)).toEqual({ quiet: { n: 4, errors: 0, medianRt: 410 } });
  });

  it(`fewer than ${String(MIN_COND_RTS)} RTs: medianRt null, and condCost null`, () => {
    expect(MIN_COND_RTS).toBe(3);
    const specs = [spec('switch'), spec('switch'), spec('repeat'), spec('repeat'), spec('repeat')];
    const results = [hit(0, 600), hit(1, 640), hit(2, 500), hit(3, 510), hit(4, 520)];
    const stats = conditionStats(specs, results);
    expect(stats.switch).toEqual({ n: 2, errors: 0, medianRt: null });
    expect(stats.repeat?.medianRt).toBe(510);
    expect(condCost(stats, 'switch', 'repeat')).toBeNull();
    expect(condCost(stats, 'repeat', 'switch')).toBeNull();
  });

  it('only press hits give RTs: late answers, misses and timed trials do not', () => {
    const specs = Array.from({ length: 6 }, () => spec('noisy'));
    const results = [
      hit(0, 300),
      hit(1, 310),
      hit(2, 320),
      hit(3, 2400, { outcome: 'late', success: false }),
      hit(4, 0, { outcome: 'miss', success: false, rtMs: null, key: null }),
      hit(5, 50, { kind: 'timed', errorMs: 5 }),
    ];
    expect(conditionStats(specs, results)).toEqual({ noisy: { n: 6, errors: 2, medianRt: 310 } });
  });

  it('trials without a condition are not counted; no conditions → {}', () => {
    expect(conditionStats([spec(), spec()], [hit(0, 300), hit(1, 300)])).toEqual({});
  });

  it('specs and results must match one to one', () => {
    expect(() => conditionStats([spec('quiet')], [])).toThrow(RangeError);
  });

  it('property: the n of all conditions add up to the non-practice trials with a condition', () => {
    const conds: (TrialCond | undefined)[] = ['congruent', 'incongruent', 'quiet', 'noisy', 'repeat', 'switch', undefined];
    const trial = fc.record({
      cond: fc.constantFrom(...conds),
      practice: fc.boolean(),
      outcome: fc.constantFrom('hit' as const, 'wrong' as const, 'miss' as const),
      rtMs: fc.integer({ min: 100, max: 2000 }),
      frameDropped: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(trial, { maxLength: 40 }), (trials) => {
        const specs = trials.map((t) => spec(t.cond, t.practice));
        const results = trials.map((t, i) =>
          hit(i, t.rtMs, { outcome: t.outcome, success: t.outcome === 'hit', practice: t.practice, frameDropped: t.frameDropped }),
        );
        const stats: ConditionStats = conditionStats(specs, results);
        const total = Object.values(stats).reduce((sum, s) => sum + s.n, 0);
        expect(total).toBe(trials.filter((t) => !t.practice && t.cond !== undefined).length);
        for (const s of Object.values(stats)) {
          expect(s.errors).toBeGreaterThanOrEqual(0);
          expect(s.errors).toBeLessThanOrEqual(s.n);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('condCost', () => {
  it('slow − fast; negative when the "slow" condition was faster', () => {
    const stats: ConditionStats = {
      quiet: { n: 5, errors: 0, medianRt: 320 },
      noisy: { n: 5, errors: 1, medianRt: 300 },
    };
    expect(condCost(stats, 'noisy', 'quiet')).toBe(-20);
  });

  it('null when a condition is missing', () => {
    expect(condCost({ quiet: { n: 5, errors: 0, medianRt: 320 } }, 'noisy', 'quiet')).toBeNull();
    expect(condCost({}, 'incongruent', 'congruent')).toBeNull();
  });
});

describe('COND_PAIRS', () => {
  it('pomeh noisy − quiet, stroop incongruent − congruent, taskswitch switch − repeat; none for the other modules', () => {
    expect(COND_PAIRS).toEqual({
      pomeh: { slow: 'noisy', fast: 'quiet' },
      stroop: { slow: 'incongruent', fast: 'congruent' },
      taskswitch: { slow: 'switch', fast: 'repeat' },
    });
    expect(REACTION_MODULE_IDS.filter((m) => condPairOf(m) !== null)).toEqual(['stroop', 'taskswitch', 'pomeh']);
    expect(condPairOf('stroop')).toBe(COND_PAIRS.stroop);
    expect(condPairOf('pzmr')).toBeNull();
  });
});
