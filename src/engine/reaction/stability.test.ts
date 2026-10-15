import { describe, expect, it } from 'vitest';
import { mean, sd } from '../stats';
import { LAPSE_MEDIAN_FACTOR, LATE_LIMIT_EXTRA_MS, lapseLimit, stabilityOf } from './stability';
import type { Outcome, TrialCond, TrialResult, TrialSpec } from './types';

/** A `press` trial for KeyF with this window (and condition). */
const press = (windowMs: number, cond?: TrialCond): TrialSpec => ({
  isiMs: 1000,
  windowMs,
  stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
  expected: { kind: 'press', key: 'KeyF' },
  ...(cond === undefined ? {} : { cond }),
});

/** The result of trial i: a `press` trial answered with KeyF after rtMs (null: no press). */
const res = (idx: number, outcome: Outcome, rtMs: number | null, o: Partial<TrialResult> = {}): TrialResult => ({
  idx,
  kind: 'press',
  outcome,
  success: outcome === 'hit' || outcome === 'correct_reject',
  rtMs,
  errorMs: null,
  key: rtMs === null ? null : 'KeyF',
  frameDropped: false,
  practice: false,
  ...o,
});

/** Hits of trials 0, 1, … at these RTs, every trial a `press` trial of `cond` with a 500 ms window. */
const hits = (rts: readonly number[], cond?: TrialCond) => ({
  specs: rts.map(() => press(500, cond)),
  results: rts.map((rt, i) => res(i, 'hit', rt)),
});

describe('stabilityOf (F2)', () => {
  it('the late limit and the lapse factor', () => {
    expect(LATE_LIMIT_EXTRA_MS).toBe(1000);
    expect(LAPSE_MEDIAN_FACTOR).toBe(1.5);
  });

  it('R takes clean hits and late presses up to window + 1000 ms', () => {
    const specs = [{ ...press(500), practice: true }, ...Array.from({ length: 8 }, () => press(500))];
    const results = [
      res(0, 'hit', 250, { practice: true }),
      res(1, 'hit', 300),
      res(2, 'hit', 320),
      res(3, 'hit', 310),
      res(4, 'hit', 330),
      res(5, 'late', 1400),
      res(6, 'late', 1600),
      res(7, 'miss', null),
      res(8, 'late', 900, { key: 'KeyJ' }),
    ];
    const R = [300, 320, 310, 330, 1400];
    const s = stabilityOf(specs, results);
    expect(s.cvAll).toBeCloseTo(sd(R) / mean(R), 12);
    // The miss, 1400 > 1.5 × 320 (the median of R) and the late press at 1600 > 500 + 1000.
    expect(s).toMatchObject({ lapses: 3, nPress: 8, lapseLimit: 2 });
  });

  it('a late press at exactly window + 1000 ms is in R; beyond it, a lapse whatever the key', () => {
    const specs = Array.from({ length: 5 }, () => press(500));
    const results = [
      res(0, 'hit', 300),
      res(1, 'hit', 310),
      res(2, 'hit', 320),
      res(3, 'late', 1500),
      res(4, 'late', 1501, { key: 'KeyJ' }),
    ];
    const s = stabilityOf(specs, results);
    expect(s.cvAll).toBeCloseTo(sd([300, 310, 320, 1500]) / mean([300, 310, 320, 1500]), 12);
    // 1500 > 1.5 × 315 and the late press beyond the limit.
    expect(s.lapses).toBe(2);
  });

  it('a hit with a dropped onset frame is left out', () => {
    const specs = Array.from({ length: 5 }, () => press(500));
    const results = [
      res(0, 'hit', 300),
      res(1, 'hit', 310),
      res(2, 'hit', 320),
      res(3, 'hit', 480, { frameDropped: true }),
      res(4, 'late', 1200, { frameDropped: true }),
    ];
    const s = stabilityOf(specs, results);
    expect(s.cvAll).toBeCloseTo(sd([300, 310, 320]) / mean([300, 310, 320]), 12);
    // Neither is a lapse: 480 > 1.5 × 310 and 1200 would be, were they in R.
    expect(s).toMatchObject({ lapses: 0, nPress: 5 });
  });

  it('conditions: SD pooled within conditions over the overall mean; lapses by the condition median', () => {
    const quiet = hits([300, 310, 320], 'quiet');
    const noisy = hits([400, 410, 420, 610], 'noisy');
    const specs = [...quiet.specs, ...noisy.specs];
    const results = [...quiet.results, ...noisy.results.map((r) => ({ ...r, idx: r.idx + 3 }))];
    const s = stabilityOf(specs, results);
    expect(s.cvAll).toBeCloseTo(Math.sqrt((100 + 0 + 100 + 3600 + 2500 + 1600 + 22500) / 5) / mean([300, 310, 320, 400, 410, 420, 610]), 12);
    // 610 < 1.5 × 415 (the median of noisy), although 610 > 1.5 × 400 (the median of all seven).
    expect(s.lapses).toBe(0);
  });

  it('trials without a condition form their own group (Р7)', () => {
    // Task switching: the first trial has no condition. In the repeat group 800 would be a lapse (> 1.5 × 515)
    // and add to its spread; alone in its group it adds neither.
    const specs = [press(1500), ...[1, 2, 3].map(() => press(1500, 'repeat')), ...[4, 5, 6].map(() => press(1500, 'switch'))];
    const rts = [800, 500, 510, 520, 600, 610, 620];
    const s = stabilityOf(
      specs,
      rts.map((rt, i) => res(i, 'hit', rt)),
    );
    expect(s.cvAll).toBeCloseTo(Math.sqrt((100 + 0 + 100 + 100 + 0 + 100) / 4) / mean(rts), 12);
    expect(s.lapses).toBe(0);
  });

  it('fewer than 3 RTs give no CV, lapses still count', () => {
    const specs = Array.from({ length: 5 }, () => press(500));
    const results = [res(0, 'hit', 300), res(1, 'hit', 310), res(2, 'miss', null), res(3, 'miss', null), res(4, 'miss', null)];
    expect(stabilityOf(specs, results)).toEqual({ cvAll: null, lapses: 3, lapseLimit: 2, nPress: 5 });
  });

  it('no CV either when no condition has two RTs (Σ(n_c − 1) = 0)', () => {
    const specs = [press(1500), press(1500, 'repeat'), press(1500, 'switch')];
    expect(stabilityOf(specs, [res(0, 'hit', 500), res(1, 'hit', 600), res(2, 'hit', 700)]).cvAll).toBeNull();
  });

  it('only `press` trials count: no-go and РДО trials, wrong keys and false starts are not answers', () => {
    const noGo: TrialSpec = { ...press(500), expected: { kind: 'withhold' } };
    const timed: TrialSpec = { ...press(500), expected: { kind: 'timed', key: 'KeyF', targetOffsetMs: 3000, toleranceMs: 60 } };
    const specs = [noGo, noGo, timed, ...Array.from({ length: 5 }, () => press(500))];
    const results = [
      res(0, 'commission', 250, { kind: 'withhold' }),
      res(1, 'correct_reject', null, { kind: 'withhold' }),
      res(2, 'hit', 3000, { kind: 'timed' }),
      res(3, 'wrong', 280, { key: 'KeyJ' }),
      res(4, 'false_start', 50),
      res(5, 'hit', 300),
      res(6, 'hit', 310),
      res(7, 'hit', 320),
    ];
    const s = stabilityOf(specs, results);
    expect(s).toMatchObject({ lapses: 0, nPress: 5 });
    expect(s.cvAll).toBeCloseTo(sd([300, 310, 320]) / mean([300, 310, 320]), 12);
    expect(stabilityOf([timed], [res(0, 'hit', 3000, { kind: 'timed' })])).toEqual({ cvAll: null, lapses: 0, lapseLimit: 2, nPress: 0 });
  });

  it('refuses a result whose trial is not a `press` trial of the block', () => {
    expect(() => stabilityOf([press(500)], [res(1, 'hit', 300)])).toThrow(RangeError);
    expect(() => stabilityOf([{ ...press(500), expected: { kind: 'withhold' } }], [res(0, 'hit', 300)])).toThrow(RangeError);
  });
});

describe('lapseLimit', () => {
  it('max(2, ⌈0.1 · nPress⌉)', () => {
    expect([0, 15, 20, 21, 50].map(lapseLimit)).toEqual([2, 2, 2, 3, 5]);
  });

  it('exact on whole tenths, where 0.1 · n would round up in floating point', () => {
    // 0.1 · 30 = 3.0000000000000004 and 0.1 · 60 = 6.000000000000001: ⌈⌉ of those would be 4 and 7.
    expect([30, 45, 60, 70].map(lapseLimit)).toEqual([3, 5, 6, 7]);
  });
});
